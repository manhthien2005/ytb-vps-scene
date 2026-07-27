from __future__ import annotations

import subprocess
import tempfile
import unittest
from array import array
from fractions import Fraction
from pathlib import Path

from tests_v2.support.fixtures import ffmpeg_available
from ytb_vps_v2.adapters.ffmpeg.audio_graph import (
    AudioMixPolicy, VoiceSegment, build_audio_graph,
)

DURATION = Fraction(600)


def graph(segments, *, source: int | None = 0, policy: AudioMixPolicy | None = None) -> str:
    return build_audio_graph(
        segments, source_input_index=source, duration_seconds=DURATION,
        policy=policy or AudioMixPolicy(),
    )


class PlacementTests(unittest.TestCase):
    def test_each_segment_is_delayed_to_its_own_timestamp(self) -> None:
        text = graph([VoiceSegment(1, Fraction(0)), VoiceSegment(2, Fraction(12, 5))])
        self.assertIn("adelay=0|0", text)
        self.assertIn("adelay=2400|2400", text)

    def test_segments_are_mixed_not_concatenated(self) -> None:
        text = graph([VoiceSegment(1, Fraction(0)), VoiceSegment(2, Fraction(5))])
        self.assertIn("amix=inputs=2", text)
        self.assertNotIn("concat", text)

    def test_fractional_start_rounds_to_whole_milliseconds(self) -> None:
        text = graph([VoiceSegment(1, Fraction(1, 3))])
        self.assertIn("adelay=333|333", text)

    def test_output_never_exceeds_the_video_duration(self) -> None:
        self.assertIn("atrim=duration=600.000", graph([VoiceSegment(1, Fraction(0))]))

    def test_output_is_padded_to_the_video_duration(self) -> None:
        self.assertIn("apad=whole_dur=600.000", graph([VoiceSegment(1, Fraction(0))]))


class MixTests(unittest.TestCase):
    def test_source_audio_is_attenuated_not_dropped(self) -> None:
        self.assertIn("volume=0.350000", graph([VoiceSegment(1, Fraction(0))]))

    def test_ducking_uses_the_voice_bus_as_the_sidechain(self) -> None:
        text = graph([VoiceSegment(1, Fraction(0))])
        self.assertIn("sidechaincompress", text)
        self.assertIn("asplit", text)

    def test_ducking_can_be_disabled(self) -> None:
        text = graph([VoiceSegment(1, Fraction(0))], policy=AudioMixPolicy(ducking=False))
        self.assertNotIn("sidechaincompress", text)
        self.assertIn("volume=0.350000", text)

    def test_zero_source_volume_drops_the_source_entirely(self) -> None:
        text = graph([VoiceSegment(1, Fraction(0))],
                     policy=AudioMixPolicy(source_volume=Fraction(0)))
        self.assertNotIn("volume=", text)
        self.assertNotIn("[0:a]", text)

    def test_a_limiter_guards_the_summed_bus(self) -> None:
        self.assertIn("alimiter", graph([VoiceSegment(1, Fraction(0))]))


class DegenerateTests(unittest.TestCase):
    def test_source_without_audio_uses_only_the_voice_bus(self) -> None:
        text = graph([VoiceSegment(1, Fraction(0))], source=None)
        self.assertNotIn("[0:a]", text)
        self.assertIn("adelay=0|0", text)

    def test_no_voice_and_no_source_yields_generated_silence(self) -> None:
        text = build_audio_graph(
            [], source_input_index=None, duration_seconds=DURATION, policy=AudioMixPolicy(),
        )
        self.assertIn("anullsrc", text)
        self.assertTrue(text.rstrip().endswith("[aout]"))

    def test_no_voice_but_source_present_keeps_the_source_unducked(self) -> None:
        text = build_audio_graph(
            [], source_input_index=0, duration_seconds=DURATION, policy=AudioMixPolicy(),
        )
        self.assertNotIn("sidechaincompress", text)
        self.assertIn("[0:a]", text)


@unittest.skipUnless(ffmpeg_available(), "ffmpeg/ffprobe required")
class AudioRunsTheWholeVideoTests(unittest.TestCase):
    """The string tests above cannot catch a truncated mix, so measure the real thing.

    `sidechaincompress` emits only as long as its SHORTER input. With an unpadded
    sidechain key the music bed dies the moment the last TTS group ends, and every
    string assertion still passes. That is precisely the silent-tail defect this
    rebuild exists to remove, so it is asserted against real ffprobe output."""

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def tone(self, name: str, seconds: str, frequency: int) -> Path:
        destination = self.root / name
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
             "-f", "lavfi", "-i", f"sine=frequency={frequency}:duration={seconds}",
             "-c:a", "pcm_s16le", str(destination)],
            check=True, capture_output=True, timeout=120,
        )
        return destination

    def mixed_output(
        self, *, bed_seconds: str, voice_starts: tuple[str, ...], total: int
    ) -> Path:
        bed = self.tone("bed.wav", bed_seconds, 220)
        voices = [
            self.tone(f"voice{index}.wav", "3", 660)
            for index in range(len(voice_starts))
        ]
        # Input 0 is the video, so the audio inputs start at 1: the bed takes index 1
        # and each voice follows. Building the graph with those indices directly is
        # what keeps every input actually referenced -- a textual rewrite of the
        # finished graph silently aliased two branches onto one input.
        segments = tuple(
            VoiceSegment(index + 2, Fraction(start))
            for index, start in enumerate(voice_starts)
        )
        graph = build_audio_graph(
            segments,
            source_input_index=1,
            duration_seconds=Fraction(total),
            policy=AudioMixPolicy(),
        )
        output = self.root / "mixed.mp4"
        arguments = [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", f"color=c=black:size=64x64:rate=30:duration={total}",
            "-i", str(bed),
        ]
        for voice in voices:
            arguments += ["-i", str(voice)]
        arguments += [
            "-filter_complex", graph,
            "-map", "0:v", "-map", "[aout]",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
            "-shortest", str(output),
        ]
        subprocess.run(arguments, check=True, capture_output=True, timeout=300)
        return output

    def measured_audio_seconds(
        self, *, bed_seconds: str, voice_starts: tuple[str, ...], total: int
    ) -> float:
        output = self.mixed_output(
            bed_seconds=bed_seconds, voice_starts=voice_starts, total=total
        )
        raw = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a:0",
             "-show_entries", "stream=duration", "-of", "csv=p=0", str(output)],
            capture_output=True, check=True, text=True, timeout=120,
        ).stdout.strip()
        return float(raw)

    def window_energy(
        self, *, bed_seconds: str, voice_starts: tuple[str, ...], total: int,
        windows: tuple[tuple[int, int], ...],
    ) -> tuple[float, ...]:
        """RMS of the mixed output inside each window, read from raw samples.

        Duration alone cannot see this defect: the final apad/atrim pins the file
        to `total` no matter what the compressor did, so a truncated bed still
        measures 20s. The symptom is a SILENT TAIL, so the tail must be measured."""
        mixed = self.mixed_output(
            bed_seconds=bed_seconds, voice_starts=voice_starts, total=total
        )
        raw = subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(mixed),
             "-map", "0:a", "-f", "s16le", "-acodec", "pcm_s16le", "-ac", "1",
             "-ar", "48000", "-"],
            capture_output=True, check=True, timeout=120,
        ).stdout
        # array is stdlib; numpy is deliberately not a declared dependency here.
        samples = array("h")
        samples.frombytes(raw[: len(raw) - len(raw) % 2])
        result = []
        for start, end in windows:
            chunk = samples[start * 48_000:end * 48_000]
            if not chunk:
                result.append(0.0)
                continue
            total_square = sum((value / 32768.0) ** 2 for value in chunk)
            result.append((total_square / len(chunk)) ** 0.5)
        return tuple(result)

    def test_the_bed_still_sounds_after_the_last_voice_group_ends(self) -> None:
        """The defect this guards: an unpadded sidechain key ends the compressor at
        the last voice, so the bed goes digitally silent for the rest of the video
        while the file duration stays a perfect 20s."""
        during, after = self.window_energy(
            bed_seconds="20", voice_starts=("0", "12"), total=20,
            windows=((12, 15), (16, 20)),
        )
        self.assertGreater(during, 0.01)
        self.assertGreater(after, 0.01, "bed went silent after the last voice group")

    def test_music_bed_survives_past_the_last_voice_group(self) -> None:
        measured = self.measured_audio_seconds(
            bed_seconds="20", voice_starts=("0", "12"), total=20
        )
        self.assertAlmostEqual(measured, 20.0, delta=0.15)

    def test_a_bed_shorter_than_the_video_is_padded_not_truncated(self) -> None:
        measured = self.measured_audio_seconds(
            bed_seconds="8", voice_starts=("0", "12"), total=20
        )
        self.assertAlmostEqual(measured, 20.0, delta=0.15)

    def test_a_bed_longer_than_the_video_is_trimmed(self) -> None:
        measured = self.measured_audio_seconds(
            bed_seconds="45", voice_starts=("0", "12"), total=20
        )
        self.assertAlmostEqual(measured, 20.0, delta=0.15)
