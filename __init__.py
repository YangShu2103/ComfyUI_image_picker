"""
Image Picker - ComfyUI Custom Node
A visual multi-image picker with file browser, supporting up to 9 images.
"""
import os
import json
import time
import glob
import hashlib
import tempfile
import torch
import numpy as np
from PIL import Image, ImageOps

try:
    import folder_paths
except Exception:
    folder_paths = None

WEB_DIRECTORY = "./js"

_node_configs = {}

IMAGE_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.webp', '.bmp'}

# ---- 缩略图缓存 ----
THUMB_SIZE = 512          # 弹窗格子约 261px，512 覆盖 2x 屏
THUMB_QUALITY = 70        # webp 质量；实测 512px 下约 22KB，往上收益很小
THUMB_MAX_BYTES = 200 * 1024 * 1024
THUMB_MAX_FILES = 10000
THUMB_PRUNE_INTERVAL = 60  # 清理检查的最小间隔（秒）
_last_prune_at = 0.0


def _thumb_cache_dir():
    """缓存放 ComfyUI 的 user 目录（不被资产系统扫描，也不会随节点更新丢失），
    拿不到就退回节点自己的目录。"""
    base = None
    if folder_paths is not None:
        try:
            base = folder_paths.get_user_directory()
        except Exception:
            base = None
    if not base:
        base = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base, "image_picker_thumbs")


def _thumb_path_hash(real_path):
    return hashlib.md5(real_path.encode("utf-8")).hexdigest()[:16]


def _thumb_cache_file(real_path, mtime, size):
    """文件名里直接编码 路径哈希+mtime+尺寸：
    mtime 变了就是新文件，顺便让删除操作能按前缀整批清理。"""
    name = f"{_thumb_path_hash(real_path)}__{int(mtime)}__{int(size)}.webp"
    return os.path.join(_thumb_cache_dir(), name)


def _drop_cached_thumbs(real_path):
    """源图被删时清掉它的所有缓存版本。"""
    pattern = os.path.join(_thumb_cache_dir(), _thumb_path_hash(real_path) + "__*")
    for f in glob.glob(pattern):
        try:
            os.remove(f)
        except OSError:
            pass


def _prune_thumb_cache():
    """超量时按最旧的缓存文件先删，避免无限增长；带间隔节流。"""
    global _last_prune_at
    now = time.time()
    if now - _last_prune_at < THUMB_PRUNE_INTERVAL:
        return
    _last_prune_at = now

    cache_dir = _thumb_cache_dir()
    try:
        entries = []
        total = 0
        with os.scandir(cache_dir) as it:
            for entry in it:
                try:
                    st = entry.stat()
                except OSError:
                    continue
                if not entry.is_file():
                    continue
                entries.append((st.st_mtime, st.st_size, entry.path))
                total += st.st_size

        if len(entries) <= THUMB_MAX_FILES and total <= THUMB_MAX_BYTES:
            return

        entries.sort()  # 最旧优先
        removed = 0
        for _, fsize, fpath in entries:
            if len(entries) - removed <= THUMB_MAX_FILES and total <= THUMB_MAX_BYTES:
                break
            try:
                os.remove(fpath)
                total -= fsize
                removed += 1
            except OSError:
                pass
        print(f"[ImagePicker] 缩略图缓存超限，已清理 {removed} 个，剩余 {total // 1024} KB")
    except FileNotFoundError:
        pass
    except Exception as exc:
        print(f"[ImagePicker] 缩略图缓存清理失败: {exc}")


def _build_thumb(src_path, dest_path, size=THUMB_SIZE):
    """把源图按最长边缩到 size 并写成 webp，先写临时文件再原子替换。"""
    cache_dir = _thumb_cache_dir()
    os.makedirs(cache_dir, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=cache_dir, suffix=".webp")
    os.close(fd)
    try:
        with Image.open(src_path) as img:
            img = ImageOps.exif_transpose(img).convert("RGB")
            img.thumbnail((size, size), Image.LANCZOS)
            img.save(tmp_path, format="WEBP", quality=THUMB_QUALITY, method=4)
        os.replace(tmp_path, dest_path)
        tmp_path = None
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass


def _resolve_image_path(p):
    """Resolve an image path that may come as a ComfyUI-relative name/annotation,
    an absolute server path, or a URL. Returns a usable local path or None."""
    p = str(p or '').strip()
    if not p:
        return None
    if p.startswith('http://') or p.startswith('https://') or p.startswith('data:'):
        return None

    # 1) ComfyUI annotated path: relative to input/output, or type:subfolder:file
    try:
        resolved = folder_paths.get_annotated_filepath(p) if folder_paths else ''
    except Exception:
        resolved = ''
    if resolved and os.path.isfile(resolved):
        return resolved

    # 2) Absolute server path (the in-node file picker uses full paths)
    if os.path.isfile(p):
        return p

    return None


class ImagePicker:
    def __init__(self):
        self._cached_node_id = None

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image_paths": ("STRING", {"default": "[]", "multiline": False}),
            },
            "hidden": {
                "node_id": "UNIQUE_ID",
            }
        }

    CATEGORY = "image"
    FUNCTION = "load_images"
    OUTPUT_NODE = False
    RETURN_TYPES = ("IMAGE",) * 9
    RETURN_NAMES = tuple(f"img_{i+1}" for i in range(9))

    def load_images(self, image_paths, node_id=None):
        self._cached_node_id = node_id

        paths = json.loads(image_paths) if image_paths else []
        paths = paths[:9]

        count = max(1, len(paths))
        if node_id:
            _node_configs[node_id] = {"count": count, "paths": paths}

        if not paths:
            return (None,) * 9

        results = []
        for p in paths:
            filepath = _resolve_image_path(p)
            if not filepath:
                print(f"[ImagePicker] Path not found: {p}")
                results.append(None)
                continue
            try:
                img = Image.open(filepath)
                img = ImageOps.exif_transpose(img)
                img = img.convert("RGB")
                img_np = np.array(img).astype(np.float32) / 255.0
                results.append(torch.from_numpy(img_np)[None,])
            except Exception as e:
                print(f"[ImagePicker] Error loading {p}: {e}")
                results.append(None)

        while len(results) < 9:
            results.append(None)

        return tuple(results)

    @classmethod
    def IS_CHANGED(cls, image_paths, node_id=None):
        return image_paths

    @classmethod
    def VALIDATE_INPUTS(cls, image_paths, node_id=None):
        return True


NODE_CLASS_MAPPINGS = {
    "ImagePicker": ImagePicker,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ImagePicker": "Image Picker",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]


# ---- API Routes ----
try:
    from aiohttp import web

    async def list_image_files(request):
        folder_type = request.rel_url.query.get("type", "input")
        if folder_paths is None:
            return web.json_response({"error": "folder_paths unavailable", "images": []}, status=500)

        if folder_type == "input":
            base_dir = folder_paths.get_input_directory()
        else:
            base_dir = folder_paths.get_output_directory()

        if not os.path.exists(base_dir):
            return web.json_response({"images": []})

        images = []
        for root, dirs, files in os.walk(base_dir):
            for f in sorted(files):
                ext = os.path.splitext(f)[1].lower()
                if ext in IMAGE_EXTENSIONS:
                    full_path = os.path.join(root, f)
                    rel_path = os.path.relpath(full_path, base_dir)
                    subfolder = os.path.dirname(rel_path)
                    try:
                        mtime = os.path.getmtime(full_path)
                    except OSError:
                        mtime = 0
                    images.append({
                        "filename": f,
                        "subfolder": subfolder if subfolder != "." else "",
                        "path": full_path,
                        "type": folder_type,
                        "mtime": mtime,
                    })

        images.sort(key=lambda item: item["mtime"], reverse=True)

        return web.json_response({"images": images})

    async def update_node_config(request):
        data = await request.json()
        node_id = data.get("node_id")
        count = min(max(1, data.get("count", 1)), 9)
        paths = data.get("paths", [])
        _node_configs[node_id] = {"count": count, "paths": paths}
        return web.json_response({"success": True})

    async def delete_image_files(request):
        data = await request.json()
        files = data.get("files", [])
        deleted = []
        failed = []
        for f in files:
            try:
                if os.path.isfile(f):
                    base_input = folder_paths.get_input_directory() if folder_paths else ""
                    base_output = folder_paths.get_output_directory() if folder_paths else ""
                    real_f = os.path.realpath(f)
                    real_in = os.path.realpath(base_input) if base_input else ""
                    real_out = os.path.realpath(base_output) if base_output else ""
                    if (real_in and real_f.startswith(real_in)) or (real_out and real_f.startswith(real_out)):
                        os.remove(f)
                        _drop_cached_thumbs(real_f)
                        deleted.append(f)
                    else:
                        failed.append({"file": f, "error": "outside allowed directories"})
                else:
                    failed.append({"file": f, "error": "not a file"})
            except Exception as e:
                failed.append({"file": f, "error": str(e)})
        return web.json_response({"success": True, "deleted": deleted, "failed": failed})

    async def thumb_image(request):
        """弹窗缩略图：服务端缩放 + 落盘缓存，替代 /view 的原图重编码。"""
        p = request.rel_url.query.get("path", "")
        try:
            size = int(request.rel_url.query.get("size", THUMB_SIZE))
        except ValueError:
            size = THUMB_SIZE
        size = min(max(size, 32), 2048)

        real_path = _resolve_image_path(p)
        if not real_path:
            return web.json_response({"error": "not found"}, status=404)

        real_f = os.path.realpath(real_path)
        if os.path.splitext(real_f)[1].lower() not in IMAGE_EXTENSIONS:
            return web.json_response({"error": "not an image"}, status=400)

        # 只允许读 input / output 目录下的文件
        allowed = []
        if folder_paths is not None:
            allowed = [
                os.path.realpath(folder_paths.get_input_directory()),
                os.path.realpath(folder_paths.get_output_directory()),
            ]
        if not any(base and real_f.startswith(base + os.sep) for base in allowed):
            return web.json_response({"error": "outside allowed directories"}, status=403)

        try:
            mtime = os.path.getmtime(real_f)
        except OSError as exc:
            return web.json_response({"error": str(exc)}, status=404)

        cache_file = _thumb_cache_file(real_f, mtime, size)
        if not os.path.isfile(cache_file):
            try:
                _build_thumb(real_f, cache_file, size)
            except Exception as exc:
                print(f"[ImagePicker] 缩略图生成失败 {p}: {exc}")
                return web.json_response({"error": "thumbnail failed"}, status=500)
            _prune_thumb_cache()

        # URL 里带了 v=mtime，源图一变 URL 就变，所以可以放心用长缓存
        return web.FileResponse(cache_file, headers={
            "Content-Type": "image/webp",
            "Cache-Control": "public, max-age=31536000, immutable",
        })

    try:
        from server import PromptServer
        _app = getattr(PromptServer.instance, "app", None) or PromptServer.instance
        if _app:
            _app.add_routes([
                web.get("/image_picker/files", list_image_files),
                web.get("/image_picker/thumb", thumb_image),
                web.post("/image_picker/update_config", update_node_config),
                web.post("/image_picker/delete_files", delete_image_files),
            ])
            print("Image Picker: API routes registered")
    except Exception as _e:
        print(f"Image Picker: Failed to register API routes: {_e}")
except Exception:
    pass

print("Image Picker: module loaded successfully")