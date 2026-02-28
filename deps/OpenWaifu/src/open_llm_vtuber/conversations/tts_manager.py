import asyncio
import json
import os
import re
import uuid
import wave
from contextlib import closing
from datetime import datetime
from typing import Any, Awaitable, Callable, List, Optional, cast
from loguru import logger

from ..agent.output_types import Actions, DisplayText
from ..live2d_model import Live2dModel
from ..tts.tts_interface import TTSInterface
from ..utils.stream_audio import prepare_audio_payload
from .types import WebSocketSend


class TTSTaskManager:
    """Manages TTS tasks and ensures ordered delivery to frontend while allowing parallel TTS generation"""

    def __init__(self) -> None:
        self.task_list: List[asyncio.Task[Any]] = []
        self._lock = asyncio.Lock()
        # Queue to store ordered payloads
        self._payload_queue: asyncio.Queue[tuple[dict[str, Any], int]] = asyncio.Queue()
        # Task to handle sending payloads in order
        self._sender_task: Optional[asyncio.Task[Any]] = None
        # Counter for maintaining order
        self._sequence_counter = 0
        self._next_sequence_to_send = 0
        self._parallel_chunk_min_chars = 120
        self._parallel_chunk_target_chars = 90
        self._parallel_chunk_max_count = 3
        self._synthesis_semaphore = asyncio.Semaphore(1)

    async def speak(
        self,
        tts_text: str,
        display_text: DisplayText,
        actions: Actions,
        live2d_model: Live2dModel,
        tts_engine: TTSInterface,
        websocket_send: WebSocketSend,
    ) -> None:
        """
        Queue a TTS task while maintaining order of delivery.

        Args:
            tts_text: Text to synthesize
            display_text: Text to display in UI
            actions: Live2D model actions
            live2d_model: Live2D model instance
            tts_engine: TTS engine instance
            websocket_send: WebSocket send function
        """
        if len(re.sub(r'[\s.,!?，。！？\'"』」）】\s]+', "", tts_text)) == 0:
            logger.debug("Empty TTS text, sending silent display payload")
            # Get current sequence number for silent payload
            current_sequence = self._sequence_counter
            self._sequence_counter += 1

            # Start sender task if not running
            if not self._sender_task or self._sender_task.done():
                self._sender_task = asyncio.create_task(
                    self._process_payload_queue(websocket_send)
                )

            await self._send_silent_payload(display_text, actions, current_sequence)
            return

        logger.debug(
            f"🏃Queuing TTS task for: '''{tts_text}''' (by {display_text.name})"
        )

        # Get current sequence number
        current_sequence = self._sequence_counter
        self._sequence_counter += 1

        # Start sender task if not running
        if not self._sender_task or self._sender_task.done():
            self._sender_task = asyncio.create_task(
                self._process_payload_queue(websocket_send)
            )

        # Create and queue the TTS task
        task = asyncio.create_task(
            self._process_tts(
                tts_text=tts_text,
                display_text=display_text,
                actions=actions,
                live2d_model=live2d_model,
                tts_engine=tts_engine,
                sequence_number=current_sequence,
            )
        )
        self.task_list.append(task)

    async def _process_payload_queue(self, websocket_send: WebSocketSend) -> None:
        """
        Process and send payloads in correct order.
        Runs continuously until all payloads are processed.
        """
        buffered_payloads: dict[int, dict[str, Any]] = {}

        while True:
            try:
                # Get payload from queue
                payload, sequence_number = await self._payload_queue.get()
                buffered_payloads[sequence_number] = payload

                # Send payloads in order
                while self._next_sequence_to_send in buffered_payloads:
                    next_payload = buffered_payloads.pop(self._next_sequence_to_send)
                    await websocket_send(json.dumps(next_payload))
                    self._next_sequence_to_send += 1

                self._payload_queue.task_done()

            except asyncio.CancelledError:
                break

    async def _send_silent_payload(
        self,
        display_text: DisplayText,
        actions: Actions,
        sequence_number: int,
    ) -> None:
        """Queue a silent audio payload"""
        audio_payload = prepare_audio_payload(
            audio_path=None,
            display_text=display_text,
            actions=actions,
        )
        await self._payload_queue.put((audio_payload, sequence_number))

    async def _process_tts(
        self,
        tts_text: str,
        display_text: DisplayText,
        actions: Actions,
        live2d_model: Live2dModel,
        tts_engine: TTSInterface,
        sequence_number: int,
    ) -> None:
        """Process TTS generation and queue the result for ordered delivery"""
        audio_file_path = None
        try:
            if not tts_text.strip():
                payload = prepare_audio_payload(
                    audio_path=None,
                    display_text=display_text,
                    actions=actions,
                )
                await self._payload_queue.put((payload, sequence_number))
                return

            async with self._synthesis_semaphore:
                audio_file_path = await self._generate_audio(tts_engine, tts_text)
                audio_file_path = self._prepend_wav_leading_silence(
                    audio_file_path, silence_seconds=0.2
                )
            payload = prepare_audio_payload(
                audio_path=audio_file_path,
                display_text=display_text,
                actions=actions,
            )
            # Queue the payload with its sequence number
            await self._payload_queue.put((payload, sequence_number))

        except Exception as e:
            logger.error(f"Error preparing audio payload: {e}")
            # Queue silent payload for error case
            payload = prepare_audio_payload(
                audio_path=None,
                display_text=display_text,
                actions=actions,
            )
            await self._payload_queue.put((payload, sequence_number))

        finally:
            if audio_file_path:
                tts_engine.remove_file(audio_file_path)
                logger.debug("Audio cache file cleaned.")

    async def _generate_audio(self, tts_engine: TTSInterface, text: str) -> str:
        """Generate audio file from text"""
        logger.debug(f"🏃Generating audio for '''{text}'''...")
        chunks = self._split_text_for_parallel_synthesis(text)
        if len(chunks) <= 1:
            return await tts_engine.async_generate_audio(
                text=text,
                file_name_no_ext=f"{datetime.now().strftime('%Y%m%d_%H%M%S')}_{str(uuid.uuid4())[:8]}",
            )

        logger.debug(
            f"🏃Parallel chunk synthesis enabled: {len(chunks)} chunks for text length {len(text)}"
        )
        base_name = (
            f"{datetime.now().strftime('%Y%m%d_%H%M%S')}_{str(uuid.uuid4())[:8]}"
        )
        chunk_file_paths: List[str] = []

        try:
            chunk_generator = getattr(
                tts_engine, "async_generate_audio_chunks_with_anchor", None
            )
            if callable(chunk_generator):
                anchored_chunk_generator = cast(
                    Callable[..., Awaitable[List[str]]], chunk_generator
                )
                chunk_file_paths = await anchored_chunk_generator(
                    chunks=chunks,
                    full_text=text,
                    file_name_prefix=base_name,
                )
            else:
                chunk_file_paths = await asyncio.gather(
                    *[
                        tts_engine.async_generate_audio(
                            text=chunk,
                            file_name_no_ext=f"{base_name}_part_{idx}",
                        )
                        for idx, chunk in enumerate(chunks)
                    ]
                )
            merged_output_path = tts_engine.generate_cache_file_name(
                file_name_no_ext=f"{base_name}_merged",
                file_extension="wav",
            )
            self._merge_wav_files(chunk_file_paths, merged_output_path)
            return merged_output_path
        except Exception as exc:
            logger.warning(
                f"Parallel chunk synthesis failed, falling back to single request: {exc}"
            )
            return await tts_engine.async_generate_audio(
                text=text,
                file_name_no_ext=base_name,
            )
        finally:
            for chunk_path in chunk_file_paths:
                tts_engine.remove_file(chunk_path, verbose=False)

    def _split_text_for_parallel_synthesis(self, text: str) -> List[str]:
        stripped = text.strip()
        if len(stripped) < self._parallel_chunk_min_chars:
            return [stripped]

        pieces = [
            piece.strip()
            for piece in re.split(r"(?<=[.!?。！？])(?:\s+|$)", stripped)
            if piece.strip()
        ]

        if len(pieces) <= 1:
            return [stripped]

        chunk_count = min(self._parallel_chunk_max_count, len(pieces))
        chunks: List[str] = []
        current_chunk: List[str] = []
        current_len = 0

        for piece in pieces:
            piece_len = len(piece)
            remaining_pieces = len(pieces) - len(chunks)
            if (
                current_chunk
                and current_len + piece_len > self._parallel_chunk_target_chars
                and len(chunks) < chunk_count - 1
                and remaining_pieces >= (chunk_count - len(chunks))
            ):
                chunks.append(" ".join(current_chunk))
                current_chunk = [piece]
                current_len = piece_len
            else:
                current_chunk.append(piece)
                current_len += piece_len

        if current_chunk:
            chunks.append(" ".join(current_chunk))

        if len(chunks) > self._parallel_chunk_max_count:
            return [stripped]
        return chunks if len(chunks) > 1 else [stripped]

    def _merge_wav_files(self, chunk_paths: List[str], output_path: str) -> None:
        if not chunk_paths:
            raise ValueError("No chunk files to merge")

        with closing(wave.open(chunk_paths[0], "rb")) as first_wav:
            params = first_wav.getparams()

        with closing(wave.open(output_path, "wb")) as output_wav:
            output_wav.setparams(params)
            for chunk_path in chunk_paths:
                with closing(wave.open(chunk_path, "rb")) as chunk_wav:
                    if chunk_wav.getparams()[:3] != params[:3]:
                        raise ValueError("WAV chunk format mismatch")
                    output_wav.writeframes(chunk_wav.readframes(chunk_wav.getnframes()))

    def _prepend_wav_leading_silence(
        self, audio_path: str, silence_seconds: float = 0.2
    ) -> str:
        if not audio_path.lower().endswith(".wav"):
            return audio_path

        temp_path = f"{audio_path}.lead"
        try:
            with closing(wave.open(audio_path, "rb")) as source_wav:
                params = source_wav.getparams()
                source_frames = source_wav.readframes(source_wav.getnframes())

            silence_frame_count = int(params.framerate * max(silence_seconds, 0.0))
            if silence_frame_count <= 0:
                return audio_path

            silence_bytes = b"\x00" * (
                silence_frame_count * params.nchannels * params.sampwidth
            )

            with closing(wave.open(temp_path, "wb")) as output_wav:
                output_wav.setparams(params)
                output_wav.writeframes(silence_bytes)
                output_wav.writeframes(source_frames)

            os.replace(temp_path, audio_path)
            return audio_path
        except Exception as exc:
            logger.warning(f"Failed to prepend leading silence: {exc}")
            if os.path.exists(temp_path):
                os.remove(temp_path)
            return audio_path

    def clear(self) -> None:
        """Clear all pending tasks and reset state"""
        self.task_list.clear()
        if self._sender_task:
            self._sender_task.cancel()
        self._sequence_counter = 0
        self._next_sequence_to_send = 0
        # Create a new queue to clear any pending items
        self._payload_queue = asyncio.Queue()
