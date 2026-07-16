# CapCut protocol helper notice

`capcut_client.py` contains the minimal TTS request/signing subset adapted from
the pure-Python `capcut-tts-api` source supplied with this workspace. It is
included so the standalone VPS tool does not import or depend on the old
`_external` checkout.

Use it only with accounts, device identities, sessions, and content that the
operator is authorized to use. The upstream workspace did not include a
separate license file; confirm redistribution rights before publishing this
folder outside the current project.

