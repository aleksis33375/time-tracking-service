"""
Stub-заглушки для тяжёлых зависимостей (face_recognition, numpy, requests),
чтобы unit-тесты запускались без dlib/cmake/сети.
"""
import sys
import types

# ── numpy stub ────────────────────────────────────────────────────────────────
numpy_stub = types.ModuleType("numpy")
numpy_stub.ndarray = list
numpy_stub.array   = list
sys.modules.setdefault("numpy", numpy_stub)

# ── face_recognition stub ─────────────────────────────────────────────────────
fr_stub = types.ModuleType("face_recognition")
fr_stub.load_image_file  = lambda path: None
fr_stub.face_encodings   = lambda img, **kw: []
fr_stub.compare_faces    = lambda known, unknown, tolerance=0.6: [False]
sys.modules.setdefault("face_recognition", fr_stub)

# ── requests stub (блокирует сеть в unit-тестах) ─────────────────────────────
import unittest.mock as mock
req_stub = types.ModuleType("requests")
req_stub.get   = mock.MagicMock(return_value=mock.MagicMock(json=lambda: [], status_code=200, content=b""))
req_stub.post  = mock.MagicMock(return_value=mock.MagicMock(json=lambda: {}, status_code=201))
req_stub.patch = mock.MagicMock(return_value=mock.MagicMock(json=lambda: {}, status_code=200))
req_stub.utils = types.SimpleNamespace(quote=lambda s: s)
sys.modules.setdefault("requests", req_stub)
