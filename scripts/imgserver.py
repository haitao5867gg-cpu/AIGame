"""Local image server for AIGame (runs on the Windows PC's GPU).

OpenAI-style endpoint: POST /v1/images/generations
  body: {"prompt": "<english>", "size": "768x768", "response_format": "b64_json"}
  returns: {"data": [{"b64_json": "<jpeg base64>"}]}
GET /health -> {"ok": true, "loaded": bool, "model": ..., "availMB": ...}
The model loads on the first request, unloads after 10 idle minutes, and is not loaded at all when
the PC has less than IMG_MIN_PHYS_MB free RAM or IMG_MIN_COMMIT_MB available commit (503 instead).

Model: SDXL base 1.0 (fp16) + ByteDance SDXL-Lightning 4-step LoRA. Listens on 127.0.0.1:8790.
Memory: UNet/VAE on the GPU, text encoders on the CPU (see load()); ~3-5 GB RAM, ~6-7 GB VRAM.
Env: IMG_MODEL, IMG_PORT, IMG_STEPS, HF_HOME (models are cached there; on the home PC it is E:\\SDXLModel).
Quick check: python imgserver.py --test "a rusty bronze key, game icon" out.jpg
"""
import base64
import ctypes
import gc
import io
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch
from diffusers import EulerDiscreteScheduler, StableDiffusionXLPipeline, UNet2DConditionModel
from huggingface_hub import hf_hub_download

MODEL = os.environ.get("IMG_MODEL", "stabilityai/stable-diffusion-xl-base-1.0")
LORA_REPO = "ByteDance/SDXL-Lightning"
LORA_FILE = "sdxl_lightning_4step_lora.safetensors"
PORT = int(os.environ.get("IMG_PORT", "8790"))
STEPS = int(os.environ.get("IMG_STEPS", "4"))

GPU_LOCK = threading.Lock()
ENCODERS = []  # [(tokenizer, text_encoder)] on the CPU, filled by load()
IDLE_UNLOAD_S = int(os.environ.get("IMG_IDLE_UNLOAD_S", "600"))  # free RAM/VRAM when nobody draws
# Refuse to load below these. Measured on the 16 GB home PC: the loaded server takes ~4 GB of RAM but
# ~10 GB of commit (WDDM backs the GPU allocations with system commit), so commit is what runs out.
MIN_PHYS_MB = int(os.environ.get("IMG_MIN_PHYS_MB", "4500"))
MIN_COMMIT_MB = int(os.environ.get("IMG_MIN_COMMIT_MB", "12000"))
LAST_USE = [time.time()]


class LowMemory(Exception):
    pass


def avail_mb():
    """(available physical MB, available commit MB) on Windows; (inf, inf) elsewhere."""
    if os.name != "nt":
        return float("inf"), float("inf")

    class MS(ctypes.Structure):
        _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
    m = MS()
    m.dwLength = ctypes.sizeof(MS)
    ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
    return m.ullAvailPhys / 1048576, m.ullAvailPageFile / 1048576


def ensure_loaded():
    """Called with GPU_LOCK held. Loads the model on demand, refusing when the PC is short of memory."""
    global PIPE
    if PIPE is not None:
        return
    phys, commit = avail_mb()
    if phys < MIN_PHYS_MB or commit < MIN_COMMIT_MB:
        raise LowMemory("low memory: %d MB free, %d MB commit available" % (phys, commit))
    PIPE = load()


def unload():
    global PIPE
    PIPE = None
    ENCODERS.clear()
    gc.collect()
    torch.cuda.empty_cache()
    log("model unloaded after %ds idle" % IDLE_UNLOAD_S)


def idle_watcher():
    while True:
        time.sleep(30)
        if PIPE is not None and time.time() - LAST_USE[0] > IDLE_UNLOAD_S:
            with GPU_LOCK:
                if PIPE is not None and time.time() - LAST_USE[0] > IDLE_UNLOAD_S:
                    unload()


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def load():
    """Low-RAM layout for a 16 GB / 8 GB-VRAM PC.

    UNet + VAE live on the GPU in fp16 (~5.3 GB VRAM); both text encoders stay on the CPU in fp32
    (~3 GB RAM; bf16 on this CPU made each image take ~47 s instead of ~5 s). The earlier "CPU offload" layout kept the whole 7 GB pipeline in RAM and starved
    the machine. The UNet is loaded straight to the GPU so peak RAM stays around 5 GB.
    """
    t = time.time()
    unet = UNet2DConditionModel.from_pretrained(
        MODEL, subfolder="unet", torch_dtype=torch.float16, variant="fp16"
    ).to("cuda")
    pipe = StableDiffusionXLPipeline.from_pretrained(
        MODEL, unet=unet, torch_dtype=torch.float16, variant="fp16"
    )
    pipe.scheduler = EulerDiscreteScheduler.from_config(
        pipe.scheduler.config, timestep_spacing="trailing"
    )
    local = os.environ.get("IMG_LORA") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "lightning4.safetensors")
    pipe.load_lora_weights(local if os.path.exists(local) else hf_hub_download(LORA_REPO, LORA_FILE))
    pipe.fuse_lora()
    pipe.unload_lora_weights()  # weights are fused; drop the LoRA copies
    pipe.vae.to("cuda")
    pipe.vae.enable_slicing()
    # Keep the CLIP encoders outside the pipeline so the pipeline's execution device is the GPU.
    ENCODERS[:] = [
        (pipe.tokenizer, pipe.text_encoder.to(torch.float32)),
        (pipe.tokenizer_2, pipe.text_encoder_2.to(torch.bfloat16)),
    ]
    pipe.register_modules(text_encoder=None, text_encoder_2=None)
    pipe.set_progress_bar_config(disable=True)
    log("model loaded in %.1fs, vram %.1f GB" % (time.time() - t, torch.cuda.memory_allocated() / 2**30))
    return pipe


@torch.no_grad()
def encode(prompt):
    """SDXL prompt encoding on the CPU: penultimate hidden states of both CLIPs + pooled bigG."""
    hs = []
    pooled = None
    for tok, enc in ENCODERS:
        ids = tok(prompt, padding="max_length", max_length=tok.model_max_length,
                  truncation=True, return_tensors="pt").input_ids
        out = enc(ids, output_hidden_states=True)
        pooled = out[0]  # for text_encoder_2 (with projection) this is the pooled text embedding
        hs.append(out.hidden_states[-2])
    pe = torch.cat(hs, dim=-1).to("cuda", torch.float16)
    return pe, pooled.to("cuda", torch.float16)


PIPE = None


def parse_size(s):
    try:
        w, h = [int(x) for x in str(s).lower().split("x")]
    except Exception:
        w, h = 768, 768
    # 768 max: at 1024 the 8 GB card spills into shared (system) memory and RAM use jumps to ~9 GB.
    clamp = lambda v: max(512, min(768, v // 8 * 8))
    return clamp(w), clamp(h)


def generate(prompt, size):
    w, h = parse_size(size)
    with GPU_LOCK:
        LAST_USE[0] = time.time()
        ensure_loaded()
        pe, pooled = encode(prompt)
        LAST_USE[0] = time.time()
        img = PIPE(
            prompt_embeds=pe,
            pooled_prompt_embeds=pooled,
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
            phys, commit = avail_mb()
            return self._send(200, {"ok": True, "loaded": PIPE is not None, "model": MODEL,
                                    "availMB": int(min(phys, commit, 1e9))})
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
        except LowMemory as e:
            log("skip:", e)
            self._send(503, {"error": {"message": str(e)}})
        except Exception as e:  # never crash the server on one bad request
            log("error", repr(e))
            if isinstance(e, torch.cuda.OutOfMemoryError):
                torch.cuda.empty_cache()
            self._send(500, {"error": {"message": str(e)[:300]}})


def main():
    # The model is loaded on the first request and unloaded after IDLE_UNLOAD_S without requests.
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=idle_watcher, daemon=True).start()
    log("listening on 127.0.0.1:%d (model loads on first request)" % PORT)
    srv.serve_forever()


if __name__ == "__main__":
    if len(sys.argv) >= 4 and sys.argv[1] == "--test":
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
