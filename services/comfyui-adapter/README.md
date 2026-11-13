# @ai-drama/comfyui-adapter

The M1-A scaffold still validates its own configuration and answers its health check. The image generation path runs in the existing Worker via `@ai-drama/providers` and connects directly to the allowed ComfyUI origin.

The Worker does not depend on this process. Check upstream availability and model dependencies with the read-only command in [the ComfyUI image runbook](../../docs/COMFYUI_IMAGE.md).
