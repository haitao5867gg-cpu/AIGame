"""Local image server for AIGame (runs on the Windows PC's GPU).

OpenAI-style endpoint: POST /v1/images/generations
  body: {"prompt": "<english>", "size": "768x768", "response_format": "b64_json"}
  returns: {"data": [{"b64_json": "<jpeg base64>"}]}
GET /health -> {"ok": true, "model": ...}

Model: SDXL base 1.0 (fp16) + ByteDance SDXL-Lightning 4-step LoRA. Listens on 127.0.0.1:8790.
Env: IMG_MODEL, IMG_PORT, IMG_STEPS, HF_HOME (models are cached there; on the home PC it is E:\\SDXLModel).
Quick check: python imgserver.py --test "a rusty bronze key, game icon" out.jpg
"""
import base64
import io
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch
from diffusers import EulerDiscreteScheduler, StableDiffusionXLPipeline
from huggingface_hub import hf_hub_download

MODEL = os.environ.get("IMG_MODEL", "stabilityai/stable-diffusion-xl-base-1.0")
LORA_REPO = "ByteDance/SDXL-Lightning"
LORA_FILE = "sdxl_lightning_4step_lora.safetensors"
PORT = int(os.environ.get("IMG_PORT", "8790"))
STEPS = int(os.environ.get("IMG_STEPS", "4"))

GPU_LOCK = threading.Lock()


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def load():
    t = time.time()
    pipe = StableDiffusionXLPipeline.from_pretrained(
        MODEL, torch_dtype=torch.float16, variant="fp16"
    )
    pipe.scheduler = EulerDiscreteScheduler.from_config(
        pipe.scheduler.config, timestep_spacing="trailing"
    )
    local = os.environ.get("IMG_LORA") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "lightning4.safetensors")
    pipe.load_lora_weights(local if os.path.exists(local) else hf_hub_download(LORA_REPO, LORA_FILE))
    pipe.fuse_lora()
    pipe.unload_lora_weights()  # weights are fused; drop the LoRA copies to save VRAM
    pipe.enable_vae_slicing()
    if os.environ.get("IMG_OFFLOAD", "1") == "1":
        # 8 GB cards: keep only the active sub-model (text encoders / unet / vae) on the GPU.
        pipe.enable_model_cpu_offload()
    else:
        pipe.to("cuda")
    pipe.set_progress_bar_config(disable=True)
    log("model loaded in %.1fs" % (time.time() - t))
    return pipe


PIPE = None


def parse_size(s):
    try:
        w, h = [int(x) for x in str(s).lower().split("x")]
    except Exception:
        w, h = 768, 768
    clamp = lambda v: max(512, min(1024, v // 8 * 8))
    return clamp(w), clamp(h)


def generate(prompt, size):
    w, h = parse_size(size)
    with GPU_LOCK:
        img = PIPE(
            prompt=prompt,
            num_inference_steps=STEPS,
            guidance_scale=0.0,
            width=w,
            height=h,
        ).images[0]
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return base64.b64encode(buf.getvalue()).decode("ascii")


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, {"ok": PIPE is not None, "model": MODEL})
        self._send(404, {"error": {"message": "not found"}})

    def do_POST(self):
        if self.path.rstrip("/") not in ("/v1/images/generations", "/images/generations"):
            return self._send(404, {"error": {"message": "not found"}})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(n) or b"{}")
            prompt = str(req.get("prompt") or "").strip()[:600]
            if not prompt:
                return self._send(400, {"error": {"message": "prompt is required"}})
            t = time.time()
            b64 = generate(prompt, req.get("size", "768x768"))
            log("ok %.2fs %s" % (time.time() - t, prompt[:80]))
            self._send(200, {"created": int(time.time()), "data": [{"b64_json": b64}]})
        except Exception as e:  # never crash the server on one bad request
            log("error", repr(e))
            if isinstance(e, torch.cuda.OutOfMemoryError):
                torch.cuda.empty_cache()
            self._send(500, {"error": {"message": str(e)[:300]}})


def main():
    global PIPE
    # Bind first: if another copy already runs, exit before loading the model into VRAM.
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    PIPE = load()
    log("listening on 127.0.0.1:%d" % PORT)
    srv.serve_forever()


if __name__ == "__main__":
    if len(sys.argv) >= 4 and sys.argv[1] == "--test":
        PIPE = load()
        for size in (sys.argv[4:] or ["768x768"]):
            t = time.time()
            data = base64.b64decode(generate(sys.argv[2], size))
            log("test %s %.2fs" % (size, time.time() - t))
        open(sys.argv[3], "wb").write(data)
        sys.exit(0)
    try:
        main()
    except OSError as e:
        log("cannot start:", e)
        sys.exit(1)
