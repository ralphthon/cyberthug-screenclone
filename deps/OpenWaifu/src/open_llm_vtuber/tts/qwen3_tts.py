import asyncio
import base64
import os
from urllib.parse import urljoin
from collections import deque
import random
import re
import threading

import requests
from requests.adapters import HTTPAdapter
from loguru import logger  # type: ignore[reportMissingImports]

from .tts_interface import TTSInterface


class _Qwen3TTSError(RuntimeError):
    def __init__(self, code: str, detail: str):
        super().__init__(detail)
        self.code: str = code
        self.detail: str = detail


class TTSEngine(TTSInterface):
    base_url: str
    endpoint: str
    api_url: str
    api_key: str | None
    api_protocol: str
    model_name: str
    language: str
    voice: str | None
    timeout: float
    max_retries: int
    fallback_model: str | None
    output_format: str
    file_extension: str
    base_instruct: str
    style_intensity: float
    _recent_interjections: deque[str]
    _rng: random.Random
    _interjection_cooldown: int
    _session_local: threading.local

    _CANONICAL_LANGUAGE: dict[str, str] = {
        "auto": "Auto",
        "chinese": "Chinese",
        "english": "English",
        "japanese": "Japanese",
        "korean": "Korean",
        "german": "German",
        "french": "French",
        "russian": "Russian",
        "portuguese": "Portuguese",
        "spanish": "Spanish",
        "italian": "Italian",
    }

    _CANONICAL_VOICE: dict[str, str] = {
        "vivian": "Vivian",
        "serena": "Serena",
        "uncle_fu": "Uncle_Fu",
        "dylan": "Dylan",
        "eric": "Eric",
        "ryan": "Ryan",
        "aiden": "Aiden",
        "ono_anna": "Ono_Anna",
        "sohee": "Sohee",
    }

    _DEFAULT_STYLE_INTENSITY: float = 1.8

    def __init__(
        self,
        base_url: str = "http://127.0.0.1:8000",
        endpoint: str = "/v1/audio/speech",
        model_name: str = "",
        api_key: str | None = None,
        api_protocol: str = "openai_speech",
        language: str = "zh",
        voice: str | None = None,
        timeout: float = 30.0,
        max_retries: int = 2,
        fallback_model: str | None = None,
        fallback_model_name: str | None = None,
        output_format: str = "wav",
        file_extension: str = "wav",
        base_instruct: str = "",
        style_intensity: float = _DEFAULT_STYLE_INTENSITY,
    ):
        self.base_url = base_url
        self.endpoint = endpoint
        self.api_url = self._build_api_url(base_url, endpoint)
        self.model_name = model_name
        self.api_key = self._resolve_api_key(api_key)
        self.api_protocol = (api_protocol or "openai_speech").strip().lower()
        self.language = self._normalize_language(language)
        self.voice = self._normalize_voice(voice)
        self.timeout = timeout
        self.max_retries = max(1, max_retries)
        self.fallback_model = fallback_model_name or fallback_model
        self.output_format = output_format
        self.file_extension = file_extension.lower()
        self.style_intensity = max(1.0, style_intensity)
        self._recent_interjections = deque(maxlen=5)
        self._rng = random.Random()
        self._interjection_cooldown = 0
        self._session_local = threading.local()
        self.base_instruct = (
            base_instruct.strip()
            if base_instruct.strip()
            else "Max expressiveness: extremely wide pitch range, dramatic high-low swings, fast pace (1.5x), clear articulation, amplified emotional contrast."
        )

    @staticmethod
    def _resolve_api_key(api_key: str | None) -> str | None:
        key = (api_key or "").strip()
        if key.startswith("${") and key.endswith("}") and len(key) > 3:
            env_name = key[2:-1].strip()
            if env_name:
                env_value = os.getenv(env_name, "").strip()
                return env_value or None
        if key:
            return key
        dashscope_key = os.getenv("DASHSCOPE_API_KEY", "").strip()
        return dashscope_key or None

    def _build_headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    _EMO_TO_INSTRUCT: dict[str, str] = {
        "joy": "Extreme joy. Highest pitch register, massive upward melodic leaps every syllable. Bright piercing head-voice, fast lively pace, pitch rockets on exclamations. Bright laughter-filled exhales between phrases, bubbly giggly breath.",
        "happy": "Extreme joy. Highest pitch register, massive upward melodic leaps every syllable. Bright piercing head-voice, fast lively pace, pitch rockets on exclamations. Bright laughter-filled exhales between phrases, bubbly giggly breath.",
        "surprise": "Explosive shock, extremely fast. Pitch violently spikes to ceiling then crashes to floor then spikes again. Maximum speed, stuttering, gasping, breathless rapid-fire, wildly unpredictable pitch. Sharp sudden gasp at start.",
        "sadness": "Deeply broken trembling voice. Pitch sinks to absolute lowest, barely audible. Sharp upward spike when voice cracks then collapses. Painfully slow, long pauses, hollow and shattered. Deep heavy trembling sighs, shaky exhales, sniffling.",
        "sad": "Deeply broken trembling voice. Pitch sinks to absolute lowest, barely audible. Sharp upward spike when voice cracks then collapses. Painfully slow, long pauses, hollow and shattered. Deep heavy trembling sighs, shaky exhales, sniffling.",
        "anger": "Explosive fury. Pitch slams to threatening low growl then violently erupts upward on stressed words. Aggressive pitch explosions on key words. Fast forceful commanding, zero hesitation. Harsh forceful nasal exhales, short explosive nose bursts.",
        "fear": "Extreme panic. Pitch shoots to shrill piercing high trembling, drops to tight whisper, spikes back in horror. Wild pitch instability, screaming highs to terrified lows. Frantic irregular bursts, stuttering, gasping. Rapid shallow hyperventilating breaths.",
        "disgust": "Deep visceral revulsion. Pitch drops to lowest guttural register, each word descends lower. Brief upward sneer on disgust words then plunges back. Deliberately slow, cold contemptuous pauses. Short held breaths, sharp disgusted exhales.",
        "neutral": "Steady even pace with clear pitch movement between phrases. Gentle rises on questions, soft falls on statements. Calm factual natural melody. Nearly silent regular breathing.",
        "smirk": "Maximum smugness. Pitch drops low and slow on setup then slides up with exaggerated sarcastic emphasis on punchline. Drawn-out teasing melodic curves, knowing condescension. Short dismissive nasal snorts, scoffing exhales.",
    }

    _STYLE_TO_INSTRUCT: dict[str, str] = {
        "interjection_soft": "When interjections or onomatopoeia appear, slightly slow the local pace and insert a brief micro-pause of around 0.2 seconds right after them before continuing.",
        "comfort": "Use a gentle, comforting tone with warm softness and steady reassuring pacing.",
        "apology": "Use a sincere apologetic tone with softened stress and careful pacing.",
        "celebration": "Use festive excitement with lively rhythm, brighter pitch movement, and crisp energy.",
        "gratitude": "Use heartfelt gratitude with warm resonance and tender emphasis.",
        "teasing": "Use playful teasing with light sarcasm, rhythmic bounce, and smiling delivery.",
        "romantic": "Use an intimate affectionate tone, soft breath, and smooth flowing cadence.",
        "whisper": "Use a whisper-like intimate delivery with reduced intensity and close-mic warmth.",
        "serious": "Use a serious focused tone with lower pitch center, stable tempo, and firm clarity.",
        "authority": "Use assertive authority with strong stress on key words and decisive rhythm.",
        "urgency": "Use urgent pacing with faster tempo, tighter phrase breaks, and heightened emphasis.",
        "curious": "Use curious inquisitive intonation with upward contours and engaged pacing.",
        "storytelling": "Use narrative storytelling cadence with expressive pauses and vivid scene coloring.",
        "instructional": "Use clear instructional delivery with measured pace and precise articulation.",
        "humor": "Use light comedic timing with playful rhythm and expressive punchlines.",
        "calm": "Use calm grounded delivery with smooth transitions and stable breath.",
    }

    _STYLE_RULES: list[tuple[str, str]] = [
        (
            "interjection_soft",
            r"\b(aww|oops|hehe|hmm|oh|ah|wow|whoa|yum|uh)\b|와!|오!|대박!|헐 대박!|야호!|어\?!|헐\?!|진짜\?!|오\?!|아니 잠깐\?!|아\.\.\.|하\.\.\.|에휴|흑|그래\.\.\.|야!|진짜!|됐어!|어이없어!|어\?|헉|설마|제발|으|윽|헐|역겨워|쯧|아~|흥|뭐|그렇겠지~|허|아|음|그렇구나|네|그래|앗|아앗|어머|허억|우와|에구|헤헤|히히|냠냠|두근두근|쿵|퐁|뿅|어라|어엇|아이쿠|헉스|오오|와아|흠흠|쉿",
        ),
        ("apology", r"\b(sorry|apolog|my bad|forgive me)\b|미안|죄송|잘못했"),
        ("gratitude", r"\b(thanks|thank you|appreciate)\b|고마워|감사"),
        (
            "celebration",
            r"\b(congrats|congratulations|awesome|amazing|yay)\b|축하|대박|최고|와{2,}",
        ),
        ("comfort", r"괜찮아|걱정\s*마|힘내|위로|it's ok|you are okay|you'll be okay"),
        ("teasing", r"장난|놀리|약올|hehe|haha|lol|😏|😉"),
        ("romantic", r"사랑|보고싶|좋아해|sweetheart|darling|dear"),
        ("whisper", r"속삭|쉿|작게 말|whisper|quietly|hush"),
        ("authority", r"반드시|당장|지금\s*해|must|need to|do it now"),
        ("urgency", r"긴급|빨리|서둘|urgent|hurry|immediately|asap"),
        ("curious", r"궁금|왜\?|어떻게\?|정말\?|\?$|\b(why|how|really\?)\b"),
        ("storytelling", r"옛날|그때|이야기|once upon a time|suddenly|meanwhile"),
        ("instructional", r"단계|방법|먼저|다음|주의|step|first|next|instructions?"),
        ("humor", r"농담|웃기|ㅋㅋ+|ㅎㅎ+|joke|funny|lmao"),
    ]

    _INTERJECTION_BY_STYLE: dict[str, list[str]] = {
        "apology": ["앗", "아이고", "어머", "에구"],
        "celebration": ["와!", "대박!", "야호!", "오!"],
        "gratitude": ["와!", "대박!", "헤헤"],
        "comfort": ["에휴", "어머", "흠흠"],
        "teasing": ["헤헤", "히히", "흥", "아~"],
        "romantic": ["헤헤", "어머", "흠흠"],
        "whisper": ["쉿", "흠흠", "헤헤"],
        "serious": ["흠흠", "음~~"],
        "authority": ["좋아", "자", "야!"],
        "urgency": ["헉", "앗", "빨리!"],
        "curious": ["어?", "오?", "흠흠"],
        "storytelling": ["흠흠", "그래...", "어라"],
        "instructional": ["좋아", "자", "흠흠"],
        "humor": ["헤헤", "히히", "앗"],
        "calm": ["흠흠", "에휴", "음~~"],
        "interjection_soft": [
            "와!",
            "헉",
            "앗",
            "어머",
            "에구",
            "헤헤",
            "히히",
            "아이쿠",
        ],
    }

    _INTERJECTION_PATTERN = re.compile(
        r"\b(aww|oops|hehe|hmm|oh|ah|wow|whoa|yum|uh|wowza|oopsie)\b|"
        r"와!|오!|대박!|헐 대박!|야호!|어\?!|헐\?!|진짜\?!|오\?!|아니 잠깐\?!|"
        r"아\.\.\.|하\.\.\.|에휴|흑|그래\.\.\.|야!|진짜!|됐어!|어이없어!|하\.\.\.|"
        r"어\?|헉|설마|제발|으|윽|헐|역겨워|쯧|아~|흥|뭐|그렇겠지~|허|"
        r"아~?|음~?|그렇구나|네|그래|"
        r"앗|아앗|어머|허억|우와|에구|헤헤|히히|냠냠|"
        r"두근두근|쿵|퐁|뿅|어라|어엇|아이쿠|헉스|오오|와아|흠흠|쉿"
    )

    def _normalize_language(self, language: str) -> str:
        language_key = (language or "").strip().lower()
        if not language_key:
            return "Auto"
        return self._CANONICAL_LANGUAGE.get(language_key, language)

    def _normalize_voice(self, voice: str | None) -> str | None:
        if not voice:
            return None
        voice_key = voice.strip().lower()
        return self._CANONICAL_VOICE.get(voice_key, voice)

    @staticmethod
    def _build_api_url(base_url: str, endpoint: str) -> str:
        normalized_base = (base_url or "").rstrip("/") + "/"
        normalized_endpoint = (endpoint or "").lstrip("/")
        return urljoin(normalized_base, normalized_endpoint)

    def _get_http_session(self) -> requests.Session:
        session = getattr(self._session_local, "session", None)
        if session is not None:
            return session

        session = requests.Session()
        adapter = HTTPAdapter(pool_connections=8, pool_maxsize=8, max_retries=0)
        session.mount("http://", adapter)
        session.mount("https://", adapter)
        self._session_local.session = session
        return session

    def _extract_prosody_markers(self, text: str) -> tuple[str, dict[str, int]]:
        prosody: dict[str, int] = {"elong": 0, "question": 0, "linebreak": 0, "exclaim": 0}
        for name, value in re.findall(
            r"<<prosody:(elong|question|linebreak|exclaim):(\d+)>>", text
        ):
            prosody[name] = max(prosody[name], int(value))
        cleaned = re.sub(r"\s*<<prosody:(elong|question|linebreak|exclaim):\d+>>\s*", " ", text)
        cleaned = re.sub(r"\s+", " ", cleaned).strip()
        return cleaned, prosody

    def _extract_emotion_markers(self, text: str) -> tuple[str, list[str]]:
        markers = re.findall(r"<<emo:([A-Za-z_][A-Za-z0-9_]*)>>", text)
        cleaned = re.sub(r"\s*<<emo:[A-Za-z_][A-Za-z0-9_]*>>\s*", " ", text)
        cleaned = re.sub(r"\s+", " ", cleaned).strip()
        return cleaned, [m.lower() for m in markers]

    def _infer_styles(self, text: str) -> list[str]:
        styles: list[str] = []
        lowered = text.lower()

        for style_name, pattern in self._STYLE_RULES:
            if re.search(pattern, lowered, flags=re.IGNORECASE):
                styles.append(style_name)

        exclamation_count = text.count("!") + text.count("！")
        question_count = text.count("?") + text.count("？")
        if (
            exclamation_count >= 2
            and "urgency" not in styles
            and "interjection_soft" not in styles
        ):
            styles.append("urgency")
        if question_count >= 1 and "curious" not in styles:
            styles.append("curious")
        if not styles:
            styles.append("calm")

        return styles[:3]

    def _intensity_directive(self) -> str:
        if self.style_intensity >= 2.0:
            return "EXTREME intensity: maximize every emotion. Most dramatic pitch arcs, wildly exaggerated rhythm, theatrical emotional coloring, no subtlety."
        if self.style_intensity >= 1.6:
            return "Intensity mode HIGH: make emotion clearly audible with high contrast, wider pitch range, and strong rhythmic variation."
        if self.style_intensity >= 1.3:
            return "Intensity mode MEDIUM-HIGH: keep emotion prominent with noticeable pitch and rhythm variation."
        return "Intensity mode NORMAL: maintain expressive but controlled emotional coloring."

    def _amplify_instruction(self, instruction: str) -> str:
        if "0.2 seconds" in instruction:
            return instruction
        if self.style_intensity >= 1.8:
            return f"{instruction} Exaggerate to absolute extreme, reject any flat delivery, perform theatrically."
        if self.style_intensity >= 1.4:
            return f"{instruction} Keep emotional emphasis clearly audible."
        return instruction

    def _contains_interjection(self, text: str) -> bool:
        return bool(self._INTERJECTION_PATTERN.search(text))

    def _pick_interjection(self, styles: list[str], emotions: list[str]) -> str:
        candidates: list[str] = []
        for style_name in styles:
            candidates.extend(self._INTERJECTION_BY_STYLE.get(style_name, []))

        for emotion in emotions:
            if emotion in {"joy", "happy"}:
                candidates.extend(["와!", "오!", "대박!", "헐 대박!", "야호!"])
            elif emotion in {"surprise"}:
                candidates.extend(["어?!", "헐?!", "진짜?!", "오?!", "아니 잠깐?!"])
            elif emotion in {"sadness", "sad"}:
                candidates.extend(["아...", "하...", "에휴", "흑", "그래..."])
            elif emotion in {"anger"}:
                candidates.extend(["야!", "진짜!", "됐어!", "어이없어!", "하..."])
            elif emotion in {"fear"}:
                candidates.extend(["어?", "헉", "아...", "설마", "제발"])
            elif emotion in {"disgust"}:
                candidates.extend(["으", "윽", "헐", "역겨워", "쯧"])
            elif emotion in {"smirk"}:
                candidates.extend(["아~~", "흥", "뭐", "그렇겟지~", "허"])
            elif emotion in {"neutral"}:
                candidates.extend(["아~~", "음~~", "그렇구나", "네", "그래"])
        if not candidates:
            candidates = self._INTERJECTION_BY_STYLE["interjection_soft"]

        dedup_candidates = list(dict.fromkeys(candidates))
        filtered = [c for c in dedup_candidates if c not in self._recent_interjections]
        selection_pool = filtered or dedup_candidates
        chosen = self._rng.choice(selection_pool)
        self._recent_interjections.append(chosen)
        return chosen

    def _should_insert_interjection(
        self, text: str, styles: list[str], emotions: list[str], prosody: dict[str, int]
    ) -> bool:
        if self._interjection_cooldown > 0:
            self._interjection_cooldown -= 1
            return False

        lowered = text.lower()
        sentence_len = len(text)
        if sentence_len > 64:
            return False

        dry_styles = {"instructional", "authority", "serious"}
        affective_styles = {
            "interjection_soft",
            "celebration",
            "apology",
            "gratitude",
            "comfort",
            "teasing",
            "humor",
            "curious",
            "romantic",
        }

        score = 0
        if any(style in affective_styles for style in styles):
            score += 2
        if any(style in dry_styles for style in styles):
            score -= 2

        affective_emotions = {"joy", "surprise", "fear", "sadness", "smirk", "anger"}
        if any(em in affective_emotions for em in emotions):
            score += 1

        if prosody.get("elong", 0) > 0 or prosody.get("question", 0) > 0:
            score += 1

        if re.search(r"고마|미안|축하|괜찮|진짜|대박|헉|와|왜|\?$", lowered):
            score += 1

        if score <= 0:
            return False

        if score >= 4:
            probability = 0.65
        elif score == 3:
            probability = 0.48
        elif score == 2:
            probability = 0.32
        else:
            probability = 0.22

        return self._rng.random() < probability

    def _maybe_insert_contextual_interjection(
        self,
        text: str,
        styles: list[str],
        emotions: list[str],
        prosody: dict[str, int],
    ) -> str:
        stripped = text.strip()
        if not stripped:
            return text
        if self._contains_interjection(stripped):
            return text

        if not self._should_insert_interjection(stripped, styles, emotions, prosody):
            return text

        interjection = self._pick_interjection(styles, emotions)
        self._interjection_cooldown = 2
        return f"{interjection} {stripped}"

    def _inject_micro_pause_after_interjections(self, text: str) -> str:
        token_pattern = (
            r"(aww|oops|hehe|hmm|oh|ah|wow|whoa|yum|uh|앗|아앗|어머|헉|허억|우와|"
            r"에구|헤헤|히히|냠냠|두근두근|뿅|어라|어엇|아이쿠|헉스|"
            r"오오|와아|흠흠|쉿)"
        )
        strong_tokens = {
            "헉",
            "허억",
            "헉스",
            "wow",
            "whoa",
            "어엇",
            "두근두근",
        }

        def _replace(match: re.Match[str]) -> str:
            token = match.group("tok")
            spacing = match.group("space")
            pause_marker = "..." if token.lower() in strong_tokens else ","
            return f"{token}{pause_marker}{spacing}"

        pattern = re.compile(
            rf"(?P<tok>{token_pattern})(?P<space>\s+)(?=[^\s,.!?，。！？])",
            flags=re.IGNORECASE,
        )
        return pattern.sub(_replace, text)

    _FILLER_ELONGATION_MAP: dict[str, str] = {
        '음': '음~~',
        '흠': '흠~~',
        '아': '아~~',
    }

    def _elongate_short_fillers(self, text: str) -> str:
        """Convert short fillers to physically elongated forms for drawn-out delivery.

        '음' -> '음~~', '흠' -> '흠~~', '아' -> '아~~'.
        Also handles punctuated forms like '음,' or '흠.'.
        """
        for short, long in self._FILLER_ELONGATION_MAP.items():
            text = re.sub(rf'(?<![가-힣a-zA-Z~]){short}[,.]\s*', f'{long} ', text)
            text = re.sub(rf'(?<![가-힣a-zA-Z~]){short}(?![가-힣a-zA-Z~])', long, text)
        return text

    def _inject_micro_pause_after_fillers(self, text: str) -> str:
        filler_pattern = (
            r"(음|음\.|음\,|흠|흠\.|흠\,|아|아\.|아\,|오|오\.|오\,|"
            r"어|어\.|어\,|그렇구나|아하|음음|흠흠|well|hmm|uh|oh)"
        )

        pattern = re.compile(
            rf"(?P<f>{filler_pattern})(?P<space>\s+)(?=[^\s,.!?，。！？])",
            flags=re.IGNORECASE,
        )

        def _replace(match: re.Match[str]) -> str:
            filler = match.group("f")
            spacing = match.group("space")
            if filler.endswith((".", ",", "?", "!")):
                return f"{filler}{spacing}"
            return f"{filler},{spacing}"

        return pattern.sub(_replace, text)

    def _normalize_text_boundaries(self, text: str) -> str:
        normalized = re.sub(r"([.!?。！？])\s*//+\s*", r"\1 ", text)
        normalized = re.sub(r"\s*//+\s*", ". ", normalized)
        normalized = re.sub(r"([.!?。！？])(?!\s|$)", r"\1 ", normalized)
        normalized = re.sub(r"([,，])(?!\s|$)", r"\1 ", normalized)
        normalized = re.sub(r"\s+", " ", normalized).strip()
        return normalized

    def _build_prosody_instruction(self, prosody: dict[str, int]) -> str:
        parts: list[str] = []
        elong = prosody.get("elong", 0)
        question = prosody.get("question", 0)
        linebreak = prosody.get("linebreak", 0)
        exclaim = prosody.get("exclaim", 0)

        if elong >= 1:
            if elong >= 3:
                parts.append(
                    "Detected strong elongation cue: stretch the sentence-final syllable clearly and keep the vowel tail warm and smooth."
                )
            elif elong == 2:
                parts.append(
                    "Detected elongation cue: gently lengthen the final syllable for a friendly drawn-out tone."
                )
            else:
                parts.append(
                    "Detected mild elongation cue: slightly sustain the final syllable without sounding exaggerated."
                )

        if question >= 1:
            if question >= 2:
                parts.append(
                    "Emphatic question: pitch must sharply rise on the last 2-3 syllables with a dramatic upward jump, like exclaiming a surprised question. Make the rising tone impossible to miss."
                )
            else:
                parts.append(
                    "Question detected: clearly raise pitch on the final syllable with a strong upward intonation lift, like asking with genuine curiosity."
                )

        if exclaim >= 1:
            if exclaim >= 2:
                parts.append(
                    "Emphatic exclamation: pitch must spike sharply upward on the last 2-3 syllables with an explosive rising burst, like shouting with intense emotion."
                )
            else:
                parts.append(
                    "Exclamation detected: raise pitch on the final syllable with a strong upward punch, delivering clear excited or emphatic rising intonation."
                )

        if linebreak >= 1:
            if linebreak >= 2:
                parts.append(
                    "Detected paragraph-like line breaks: after each line break boundary, pause naturally for about 0.20 seconds before continuing."
                )
            else:
                parts.append(
                    "Detected line break boundary: insert a natural pause of about 0.20 seconds at that boundary."
                )

        return " ".join(parts)

    def _build_comma_pause_instruction(self, cleaned_text: str) -> str:
        comma_count = cleaned_text.count(",") + cleaned_text.count("，")
        sentence_break_count = (
            cleaned_text.count(".")
            + cleaned_text.count("。")
            + cleaned_text.count("!")
            + cleaned_text.count("！")
            + cleaned_text.count("?")
            + cleaned_text.count("？")
        )
        if comma_count <= 0 and sentence_break_count <= 0:
            return ""

        if comma_count > 0 and sentence_break_count > 0:
            return (
                "Detected comma and sentence boundaries: place a natural pause of about 0.2 seconds "
                "after each comma, and a clearer transition pause of about 0.3 seconds "
                "at each sentence boundary."
            )

        if comma_count > 0:
            return (
                "Detected comma phrase break: place a natural pause of about 0.2 seconds "
                "at each comma boundary."
            )

        return (
            "Detected sentence boundaries: place a clear transition pause of about 0.3 seconds "
            "at each sentence boundary."
        )

    def _build_breath_instruction(
        self, cleaned_text: str, prosody: dict[str, int], emotions: list[str] | None = None
    ) -> str:
        # Emotion-specific breath overrides (concise)
        _EMO_BREATH: dict[str, str] = {
            "joy": "Bright laughter-filled exhales, bubbly giggly breath.",
            "happy": "Bright laughter-filled exhales, bubbly giggly breath.",
            "anger": "Harsh forceful nasal exhales, short explosive nose bursts.",
            "disgust": "Short held breaths, sharp disgusted exhales, reluctant inhales.",
            "fear": "Rapid shallow hyperventilating, fast trembling breath cycles.",
            "sadness": "Deep heavy trembling sighs, shaky exhales, sniffling.",
            "sad": "Deep heavy trembling sighs, shaky exhales, sniffling.",
            "surprise": "Loud sharp sudden gasp, dramatic involuntary inhale.",
            "smirk": "Short dismissive nasal snorts, scoffing exhales.",
            "neutral": "Nearly silent regular breathing.",
        }
        
        # Check if any emotion has a specific breath pattern
        if emotions:
            for emo in emotions:
                if emo in _EMO_BREATH:
                    return _EMO_BREATH[emo]
        
        always_breath = (
            "Always add a very soft inhale-like breath at sentence start and a soft exhale-like release at sentence end. "
            "Keep breaths subtle and natural, not exaggerated."
        )
        has_filler = bool(
            re.search(
                r"(^|\s)(음~?|흠~?|아~?|오|어|그렇구나|아하|음음|흠흠|well|hmm|uh|oh)([,.!?，。！？]|\s|$)",
                cleaned_text,
                flags=re.IGNORECASE,
            )
        )
        boundary_count = (
            cleaned_text.count(",")
            + cleaned_text.count("，")
            + cleaned_text.count(".")
            + cleaned_text.count("!")
            + cleaned_text.count("?")
            + cleaned_text.count("。")
            + cleaned_text.count("！")
            + cleaned_text.count("？")
        )
        if boundary_count <= 0:
            if has_filler:
                return (
                    always_breath
                    + " When filler words like '음~~' or '흠~~' appear, draw them out slowly and softly with a warm sustained hum. Add a very brief breathy micro-pause of about 0.10 to 0.16 seconds after them."
                )
            return (
                always_breath
                + " Use gentle phrase transitions with occasional subtle breathy release between clauses."
            )

        if prosody.get("question", 0) >= 1:
            filler_clause = ""
            if has_filler:
                filler_clause = " When filler words like '음~~' or '흠~~' appear, draw them out slowly with a warm sustained hum, then place a soft micro-pause of about 0.10 to 0.16 seconds."
            return (
                always_breath
                + " At clause boundaries, add a tiny human-like breathy pause of about 0.12 to 0.20 seconds. "
                "Question ending: sharply raise pitch on final syllables with strong upward lift."
                + filler_clause
            )

        filler_clause = ""
        if has_filler:
            filler_clause = " When filler words like '음~~' or '흠~~' appear, draw them out slowly with a warm sustained hum, then place a soft micro-pause of about 0.10 to 0.16 seconds."
        return (
            always_breath
            + " At clause boundaries, add tiny human-like breathy pauses of about 0.12 to 0.20 seconds, "
            "while keeping sentence flow smooth and conversational." + filler_clause
        )

    def _build_instruct(
        self,
        cleaned_text: str,
        emotions: list[str],
        prosody: dict[str, int],
        selected_styles: list[str] | None = None,
    ) -> str:
        parts: list[str] = []
        if self.base_instruct:
            parts.append(self.base_instruct)
        parts.append(self._intensity_directive())
        prosody_instruction = self._build_prosody_instruction(prosody)
        if prosody_instruction:
            parts.append(prosody_instruction)
        comma_pause_instruction = self._build_comma_pause_instruction(cleaned_text)
        if comma_pause_instruction:
            parts.append(comma_pause_instruction)
        breath_instruction = self._build_breath_instruction(cleaned_text, prosody, emotions)
        if breath_instruction:
            parts.append(breath_instruction)
        selected_styles = selected_styles or self._infer_styles(cleaned_text)
        for style_name in selected_styles:
            style_instruction = self._STYLE_TO_INSTRUCT.get(style_name)
            if style_instruction and style_instruction not in parts:
                parts.append(self._amplify_instruction(style_instruction))
        for emotion in emotions:
            instruction = self._EMO_TO_INSTRUCT.get(emotion)
            if instruction and instruction not in parts:
                parts.append(
                    self._amplify_instruction(
                        f"Secondary cue from facial expression tag '{emotion}': {instruction}"
                    )
                )
        logger.debug(
            f"Qwen3 TTS style routing styles={selected_styles} emotions={emotions} text='{cleaned_text[:80]}'"
        )
        return " ".join(parts)

    def _build_payload(
        self,
        text: str,
        model_name: str,
        instruct_override: str | None = None,
        allow_contextual_interjection: bool = True,
        forced_styles: list[str] | None = None,
    ) -> dict[str, str]:
        cleaned_text, prosody = self._extract_prosody_markers(text)
        cleaned_text, emotions = self._extract_emotion_markers(cleaned_text)
        styles = forced_styles or self._infer_styles(cleaned_text)
        if allow_contextual_interjection:
            cleaned_text = self._maybe_insert_contextual_interjection(
                cleaned_text, styles, emotions, prosody
            )
        cleaned_text = self._inject_micro_pause_after_interjections(cleaned_text)
        cleaned_text = self._elongate_short_fillers(cleaned_text)
        cleaned_text = self._inject_micro_pause_after_fillers(cleaned_text)
        cleaned_text = self._normalize_text_boundaries(cleaned_text)
        if prosody.get("elong", 0) >= 1 and not cleaned_text.endswith("..."):
            cleaned_text = f"{cleaned_text}..."
        payload = {
            "model": model_name,
            "language": self.language,
            "text": cleaned_text,
            "output_format": self.output_format,
        }
        if self.voice:
            payload["voice"] = self.voice
        instruct = instruct_override or self._build_instruct(
            cleaned_text,
            emotions,
            prosody,
            selected_styles=styles,
        )
        if instruct:
            payload["instruct"] = instruct
        return payload

    def _request_audio(
        self,
        text: str,
        model_name: str,
        instruct_override: str | None = None,
        allow_contextual_interjection: bool = True,
        forced_styles: list[str] | None = None,
    ) -> bytes:
        if self.api_protocol == "dashscope_multimodal":
            cleaned_text, prosody = self._extract_prosody_markers(text)
            cleaned_text, emotions = self._extract_emotion_markers(cleaned_text)
            styles = forced_styles or self._infer_styles(cleaned_text)
            if allow_contextual_interjection:
                cleaned_text = self._maybe_insert_contextual_interjection(
                    cleaned_text, styles, emotions, prosody
                )
            cleaned_text = self._inject_micro_pause_after_interjections(cleaned_text)
            cleaned_text = self._elongate_short_fillers(cleaned_text)
            cleaned_text = self._inject_micro_pause_after_fillers(cleaned_text)
            cleaned_text = self._normalize_text_boundaries(cleaned_text)
            if prosody.get("elong", 0) >= 1 and not cleaned_text.endswith("..."):
                cleaned_text = f"{cleaned_text}..."

            dashscope_payload: dict[str, object] = {
                "model": model_name,
                "input": {
                    "text": cleaned_text,
                },
            }
            input_payload = dashscope_payload["input"]
            if not isinstance(input_payload, dict):
                raise _Qwen3TTSError("CONFIG", "Invalid DashScope payload structure")
            if self.voice:
                input_payload["voice"] = self.voice
            if self.language:
                input_payload["language_type"] = self.language
            instruct = instruct_override or self._build_instruct(
                cleaned_text,
                emotions,
                prosody,
                selected_styles=styles,
            )
            if instruct:
                input_payload["instructions"] = instruct
                dashscope_payload["parameters"] = {"optimize_instructions": True}

            try:
                response = self._get_http_session().post(
                    self.api_url,
                    headers=self._build_headers(),
                    json=dashscope_payload,
                    timeout=self.timeout,
                )
            except requests.Timeout as exc:
                raise _Qwen3TTSError(
                    "TIMEOUT", f"Request timed out after {self.timeout}s"
                ) from exc
            except requests.RequestException as exc:
                raise _Qwen3TTSError("NETWORK", f"Network failure: {exc}") from exc

            if response.status_code >= 500:
                raise _Qwen3TTSError(
                    "HTTP_5XX",
                    f"Server error {response.status_code}: {response.text[:200]}",
                )
            if response.status_code >= 400:
                raise _Qwen3TTSError(
                    "HTTP_4XX",
                    f"Client error {response.status_code}: {response.text[:200]}",
                )

            try:
                body = response.json()
            except ValueError as exc:
                raise _Qwen3TTSError(
                    "INVALID_RESPONSE",
                    f"DashScope response is not valid JSON: {response.text[:200]}",
                ) from exc

            output = body.get("output") if isinstance(body, dict) else None
            audio = output.get("audio") if isinstance(output, dict) else None
            audio_data = audio.get("data") if isinstance(audio, dict) else None
            audio_url = audio.get("url") if isinstance(audio, dict) else None

            if isinstance(audio_data, str) and audio_data:
                try:
                    return base64.b64decode(audio_data)
                except ValueError as exc:
                    raise _Qwen3TTSError(
                        "INVALID_AUDIO_DATA",
                        "DashScope returned invalid base64 audio data",
                    ) from exc

            if isinstance(audio_url, str) and audio_url:
                try:
                    audio_response = self._get_http_session().get(
                        audio_url,
                        timeout=self.timeout,
                    )
                except requests.Timeout as exc:
                    raise _Qwen3TTSError(
                        "TIMEOUT", f"Audio download timed out after {self.timeout}s"
                    ) from exc
                except requests.RequestException as exc:
                    raise _Qwen3TTSError(
                        "NETWORK", f"Audio download failed: {exc}"
                    ) from exc

                if audio_response.status_code >= 400:
                    raise _Qwen3TTSError(
                        "AUDIO_DOWNLOAD_FAILED",
                        f"Audio download failed {audio_response.status_code}: {audio_response.text[:200]}",
                    )
                if not audio_response.content:
                    raise _Qwen3TTSError(
                        "EMPTY_AUDIO", "DashScope audio URL returned empty content"
                    )
                return audio_response.content

            raise _Qwen3TTSError(
                "INVALID_RESPONSE",
                f"DashScope response missing output.audio.url/data: {str(body)[:200]}",
            )

        payload = self._build_payload(
            text,
            model_name,
            instruct_override=instruct_override,
            allow_contextual_interjection=allow_contextual_interjection,
            forced_styles=forced_styles,
        )
        try:
            response = self._get_http_session().post(
                self.api_url,
                headers=self._build_headers(),
                json=payload,
                timeout=self.timeout,
            )
        except requests.Timeout as exc:
            raise _Qwen3TTSError(
                "TIMEOUT", f"Request timed out after {self.timeout}s"
            ) from exc
        except requests.RequestException as exc:
            raise _Qwen3TTSError("NETWORK", f"Network failure: {exc}") from exc

        if response.status_code >= 500:
            raise _Qwen3TTSError(
                "HTTP_5XX",
                f"Server error {response.status_code}: {response.text[:200]}",
            )
        if response.status_code >= 400:
            raise _Qwen3TTSError(
                "HTTP_4XX",
                f"Client error {response.status_code}: {response.text[:200]}",
            )
        if not response.content:
            raise _Qwen3TTSError("EMPTY_AUDIO", "Backend returned empty audio payload")
        return response.content

    def generate_audio(self, text: str, file_name_no_ext: str | None = None) -> str:
        cache_file = self.generate_cache_file_name(
            file_name_no_ext, self.file_extension
        )
        models_to_try = [(self.model_name, self.max_retries)]
        if self.fallback_model and self.fallback_model != self.model_name:
            models_to_try.append((self.fallback_model, 1))

        last_error: _Qwen3TTSError | None = None

        for model_name, attempts in models_to_try:
            for attempt in range(1, attempts + 1):
                try:
                    audio_content = self._request_audio(text, model_name)
                    with open(cache_file, "wb") as audio_file:
                        _ = audio_file.write(audio_content)
                    return cache_file
                except OSError as exc:
                    last_error = _Qwen3TTSError(
                        "WRITE_ERROR",
                        f"Failed writing audio file '{cache_file}': {exc}",
                    )
                    logger.error(
                        f"Qwen3 TTS failure ({last_error.code}) model={model_name} attempt={attempt}/{attempts}: {last_error.detail}"
                    )
                    break
                except _Qwen3TTSError as exc:
                    last_error = exc
                    logger.warning(
                        f"Qwen3 TTS failure ({exc.code}) model={model_name} attempt={attempt}/{attempts}: {exc.detail}"
                    )

            if model_name != models_to_try[-1][0]:
                logger.warning(
                    f"Qwen3 TTS primary model failed after {attempts} attempts; trying fallback model '{models_to_try[-1][0]}'"
                )

        if last_error is None:
            raise _Qwen3TTSError("CONFIG", "No available model to process request")

        logger.error(
            f"Qwen3 TTS unrecoverable failure ({last_error.code}): {last_error.detail}"
        )
        raise last_error

    def _build_tone_anchor(self, full_text: str) -> tuple[str, list[str]]:
        cleaned_text, prosody = self._extract_prosody_markers(full_text)
        cleaned_text, emotions = self._extract_emotion_markers(cleaned_text)
        anchor_styles = self._infer_styles(cleaned_text)
        anchor_instruct = self._build_instruct(
            cleaned_text,
            emotions,
            prosody,
            selected_styles=anchor_styles,
        )
        anchor_instruct += (
            " Keep one consistent core tone color, speaking persona, and emotional baseline "
            "across all chunks of this same sentence."
        )
        return anchor_instruct, anchor_styles

    def _generate_chunk_with_anchor(
        self,
        chunk_text: str,
        cache_file: str,
        anchor_instruct: str,
        anchor_styles: list[str],
    ) -> str:
        models_to_try = [(self.model_name, self.max_retries)]
        if self.fallback_model and self.fallback_model != self.model_name:
            models_to_try.append((self.fallback_model, 1))

        last_error: _Qwen3TTSError | None = None

        for model_name, attempts in models_to_try:
            for attempt in range(1, attempts + 1):
                try:
                    audio_content = self._request_audio(
                        chunk_text,
                        model_name,
                        instruct_override=anchor_instruct,
                        allow_contextual_interjection=False,
                        forced_styles=anchor_styles,
                    )
                    with open(cache_file, "wb") as audio_file:
                        _ = audio_file.write(audio_content)
                    return cache_file
                except OSError as exc:
                    raise _Qwen3TTSError(
                        "WRITE_ERROR",
                        f"Failed writing audio file '{cache_file}': {exc}",
                    ) from exc
                except _Qwen3TTSError as exc:
                    last_error = exc
                    logger.warning(
                        f"Qwen3 chunk TTS failure ({exc.code}) model={model_name} attempt={attempt}/{attempts}: {exc.detail}"
                    )

        if last_error is None:
            raise _Qwen3TTSError(
                "CONFIG", "No available model to process chunk request"
            )
        raise last_error

    async def async_generate_audio_chunks_with_anchor(
        self,
        chunks: list[str],
        full_text: str,
        file_name_prefix: str,
    ) -> list[str]:
        anchor_instruct, anchor_styles = self._build_tone_anchor(full_text)
        return await asyncio.gather(
            *[
                asyncio.to_thread(
                    self._generate_chunk_with_anchor,
                    chunk,
                    self.generate_cache_file_name(
                        file_name_no_ext=f"{file_name_prefix}_part_{idx}",
                        file_extension=self.file_extension,
                    ),
                    anchor_instruct,
                    anchor_styles,
                )
                for idx, chunk in enumerate(chunks)
            ]
        )
