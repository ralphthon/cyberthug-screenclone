import numpy as np
from typing import Any, Optional
from faster_whisper import WhisperModel
from .asr_interface import ASRInterface


class VoiceRecognition(ASRInterface):
    BEAM_SIZE = 1
    ALLOWED_LANGUAGES = {"en", "ko"}
    # SAMPLE_RATE # Defined in asr_interface.py

    def __init__(
        self,
        model_path: str = "distil-medium.en",
        download_root: Optional[str] = None,
        language: str = "en",
        device: str = "auto",
        compute_type: str = "int8",
        prompt: Optional[str] = None,
    ) -> None:
        self.MODEL_PATH = model_path
        self.LANG = language
        self.prompt = prompt
        self.model = WhisperModel(
            model_size_or_path=model_path,
            download_root=download_root,
            device=device,
            compute_type=compute_type,
        )

    def transcribe_np(self, audio: np.ndarray[Any, Any]) -> str:
        language = self.LANG if self.LANG and self.LANG != "auto" else None

        if self.prompt:
            segments, info = self.model.transcribe(
                audio,
                beam_size=self.BEAM_SIZE,
                language=language,
                condition_on_previous_text=False,
                initial_prompt=self.prompt,
            )
        else:
            segments, info = self.model.transcribe(
                audio,
                beam_size=self.BEAM_SIZE,
                language=language,
                condition_on_previous_text=False,
            )

        detected_language = (getattr(info, "language", "") or "").lower()
        if detected_language and detected_language not in self.ALLOWED_LANGUAGES:
            return ""

        text = [segment.text for segment in segments]

        if not text:
            return ""
        else:
            return "".join(text)
