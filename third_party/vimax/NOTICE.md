# ViMax interface attribution

The offline evaluation schemas use property names and data shapes from HKUDS/ViMax at commit `fd4b72e7731be6e5f88486206d25ea59849b0285`:

- `interfaces/character.py`
- `interfaces/shot_description.py`
- `interfaces/camera.py`
- `pipelines/script2video_pipeline.py` (planning result structure)

Source: https://github.com/HKUDS/ViMax/tree/fd4b72e7731be6e5f88486206d25ea59849b0285

The upstream MIT license is preserved in [LICENSE](LICENSE). Our strict local admission limits, source/dialogue validation, supplements, mapping and offline runner are implemented for AI Drama Studio. No ViMax agent prompt, Python implementation, model, image, video or example media is bundled or executed. The fixture is synthetic. This notice does not establish permission for third-party model weights, services or media.
