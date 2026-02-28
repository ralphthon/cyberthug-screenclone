import base64
import audioop
import os
import wave
from contextlib import closing
from typing import Any, Dict, List, Optional, cast
from pydub import AudioSegment
from ..agent.output_types import Actions
from ..agent.output_types import DisplayText


def _get_volume_by_chunks(audio: AudioSegment, chunk_length_ms: int) -> List[float]:
    """
    Calculate the normalized volume (RMS) for each chunk of the audio.

    Parameters:
        audio (AudioSegment): The audio segment to process.
        chunk_length_ms (int): The length of each audio chunk in milliseconds.

    Returns:
        list: Normalized volumes for each chunk.
    """
    duration_ms = len(audio)
    chunks: List[Any] = []
    for start_ms in range(0, duration_ms, chunk_length_ms):
        chunks.append(audio[start_ms : start_ms + chunk_length_ms])
    volumes = [float(cast(Any, chunk).rms) for chunk in chunks]
    max_volume = max(volumes)
    if max_volume == 0:
        raise ValueError("Audio is empty or all zero.")
    return [volume / max_volume for volume in volumes]


def _get_volume_by_wav_file(audio_path: str, chunk_length_ms: int) -> List[float]:
    with closing(wave.open(audio_path, "rb")) as wav_file:
        channels = wav_file.getnchannels()
        sample_width = wav_file.getsampwidth()
        frame_rate = wav_file.getframerate()
        total_frames = wav_file.getnframes()

        if total_frames <= 0 or frame_rate <= 0:
            raise ValueError("Audio is empty or invalid.")

        frames_per_chunk = max(1, int(frame_rate * chunk_length_ms / 1000))
        volumes: list[float] = []
        wav_file.rewind()
        while True:
            chunk = wav_file.readframes(frames_per_chunk)
            if not chunk:
                break
            mono_chunk = (
                audioop.tomono(chunk, sample_width, 0.5, 0.5)
                if channels == 2
                else chunk
            )
            rms = audioop.rms(mono_chunk, sample_width)
            volumes.append(float(rms))

    max_volume = max(volumes, default=0.0)
    if max_volume <= 0:
        raise ValueError("Audio is empty or all zero.")
    return [volume / max_volume for volume in volumes]


def prepare_audio_payload(
    audio_path: Optional[str],
    chunk_length_ms: int = 20,
    display_text: Optional[DisplayText] = None,
    actions: Optional[Actions] = None,
    forwarded: bool = False,
) -> Dict[str, Any]:
    """
    Prepares the audio payload for sending to a broadcast endpoint.
    If audio_path is None, returns a payload with audio=None for silent display.

    Parameters:
        audio_path (str | None): The path to the audio file to be processed, or None for silent display
        chunk_length_ms (int): The length of each audio chunk in milliseconds
        display_text (DisplayText, optional): Text to be displayed with the audio
        actions (Actions, optional): Actions associated with the audio

    Returns:
        dict: The audio payload to be sent
    """
    payload_display_text: Optional[Dict[str, Any]]
    if isinstance(display_text, DisplayText):
        payload_display_text = display_text.to_dict()
    else:
        payload_display_text = None

    if not audio_path:
        # Return payload for silent display
        return {
            "type": "audio",
            "audio": None,
            "volumes": [],
            "slice_length": chunk_length_ms,
            "display_text": payload_display_text,
            "actions": actions.to_dict() if actions else None,
            "forwarded": forwarded,
        }

    ext = os.path.splitext(audio_path)[1].lower()
    try:
        if ext == ".wav":
            with open(audio_path, "rb") as audio_file:
                audio_bytes = audio_file.read()
            volumes = _get_volume_by_wav_file(audio_path, chunk_length_ms)
        else:
            audio = AudioSegment.from_file(audio_path)
            audio_bytes = audio.export(format="wav").read()
            volumes = _get_volume_by_chunks(audio, chunk_length_ms)
    except Exception as e:
        raise ValueError(
            f"Error loading or converting generated audio file to wav file '{audio_path}': {e}"
        )
    audio_base64 = base64.b64encode(audio_bytes).decode("utf-8")

    payload = {
        "type": "audio",
        "audio": audio_base64,
        "volumes": volumes,
        "slice_length": chunk_length_ms,
        "display_text": payload_display_text,
        "actions": actions.to_dict() if actions else None,
        "forwarded": forwarded,
    }

    return payload


# Example usage:
# payload, duration = prepare_audio_payload("path/to/audio.mp3", display_text="Hello", expression_list=[0,1,2])
