"""
Unit-тесты для бизнес-логики AI Worker.
Запуск: pytest tests/test_worker.py -v
Зависимости: только stdlib + pytest (pip install pytest).
face_recognition, numpy, requests — заглушены в conftest.py.
"""
import os
import sys
import pytest

# Нужные env-переменные до импорта воркера
os.environ.setdefault("SUPABASE_URL",              "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test-key")

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "ai-worker"))
import process_events as w   # noqa: E402  — после patching


# ═══════════════════════════════════════════════════════════════════════════════
# moscow_date_of
# ═══════════════════════════════════════════════════════════════════════════════

class TestMoscowDateOf:
    def test_midnight_utc_is_previous_msk_day(self):
        # 00:00 UTC = 03:00 МСК → та же дата
        assert w.moscow_date_of("2026-04-15T00:00:00+00:00") == "2026-04-15"

    def test_2100_utc_is_next_msk_day(self):
        # 21:00 UTC = 00:00 следующего дня МСК
        assert w.moscow_date_of("2026-04-14T21:00:00+00:00") == "2026-04-15"

    def test_z_suffix(self):
        assert w.moscow_date_of("2026-04-15T10:00:00Z") == "2026-04-15"

    def test_noon_msk(self):
        # 09:00 UTC = 12:00 МСК
        assert w.moscow_date_of("2026-04-15T09:00:00Z") == "2026-04-15"

    def test_midnight_msk_boundary(self):
        # 20:59 UTC = 23:59 МСК → ещё 14-е
        assert w.moscow_date_of("2026-04-14T20:59:59Z") == "2026-04-14"
        # 21:00 UTC = 00:00 МСК → уже 15-е
        assert w.moscow_date_of("2026-04-14T21:00:00Z") == "2026-04-15"


# ═══════════════════════════════════════════════════════════════════════════════
# resolve_event_type
# ═══════════════════════════════════════════════════════════════════════════════

class TestResolveEventType:
    def _ev(self, event_type=None, event_type_raw=""):
        return {"event_type": event_type, "event_type_raw": event_type_raw}

    # Бот уже поставил тип
    def test_arrival_from_event_type(self):
        assert w.resolve_event_type(self._ev("arrival")) == "arrival"

    def test_departure_from_event_type(self):
        assert w.resolve_event_type(self._ev("departure")) == "departure"

    # Парсинг raw-текста
    def test_raw_nachalo_smeny(self):
        assert w.resolve_event_type(self._ev(None, "начало смены")) == "arrival"

    def test_raw_konec_smeny(self):
        assert w.resolve_event_type(self._ev(None, "конец смены")) == "departure"

    def test_raw_prikhod(self):
        assert w.resolve_event_type(self._ev(None, "Приход")) == "arrival"

    def test_raw_ukhod(self):
        assert w.resolve_event_type(self._ev(None, "Уход")) == "departure"

    def test_raw_prishjol(self):
        assert w.resolve_event_type(self._ev(None, "пришёл")) == "arrival"

    def test_raw_ushyol(self):
        assert w.resolve_event_type(self._ev(None, "ушёл")) == "departure"

    def test_unknown_raw(self):
        assert w.resolve_event_type(self._ev(None, "что-то непонятное")) is None

    def test_empty_event(self):
        assert w.resolve_event_type({"event_type": None, "event_type_raw": None}) is None

    def test_wrong_event_type_value(self):
        # Значение не arrival/departure — должен парсить raw
        assert w.resolve_event_type(self._ev("unknown", "начало смены")) == "arrival"


# ═══════════════════════════════════════════════════════════════════════════════
# build_fraud_flags
# ═══════════════════════════════════════════════════════════════════════════════

class TestBuildFraudFlags:
    def _ev(self, flags):
        return {"fraud_flags": flags}

    def test_no_existing_flags_face_ok(self):
        assert w.build_fraud_flags(self._ev([]), True) == []

    def test_no_existing_flags_face_mismatch(self):
        assert w.build_fraud_flags(self._ev([]), False) == ["face_mismatch"]

    def test_existing_wrong_location_face_mismatch(self):
        flags = w.build_fraud_flags(self._ev(["wrong_location"]), False)
        assert "wrong_location"  in flags
        assert "face_mismatch"   in flags

    def test_no_duplicate_face_mismatch(self):
        flags = w.build_fraud_flags(self._ev(["face_mismatch"]), False)
        assert flags.count("face_mismatch") == 1

    def test_face_none_no_flag_added(self):
        # None = нет эталона, не добавляем face_mismatch
        assert w.build_fraud_flags(self._ev([]), None) == []

    def test_none_fraud_flags_field(self):
        # fraud_flags = None в базе
        flags = w.build_fraud_flags({"fraud_flags": None}, False)
        assert "face_mismatch" in flags


# ═══════════════════════════════════════════════════════════════════════════════
# needs_review
# ═══════════════════════════════════════════════════════════════════════════════

class TestNeedsReview:
    EMP = {"id": "abc", "display_name": "Дима"}

    def test_ok_case(self):
        assert w.needs_review(self.EMP, True, []) is False

    def test_no_employee(self):
        assert w.needs_review(None, None, []) is True

    def test_face_mismatch(self):
        assert w.needs_review(self.EMP, False, []) is True

    def test_fraud_flags_present(self):
        assert w.needs_review(self.EMP, True, ["wrong_location"]) is True

    def test_face_none_no_flags(self):
        # face_match=None → нет эталона → не причина для review
        assert w.needs_review(self.EMP, None, []) is False

    def test_face_none_with_flags(self):
        assert w.needs_review(self.EMP, None, ["wrong_location"]) is True


# ═══════════════════════════════════════════════════════════════════════════════
# is_incomplete_day
# ═══════════════════════════════════════════════════════════════════════════════

class TestIsIncompleteDay:
    EMP = {"id": "abc", "display_name": "Дима"}

    def test_complete_day(self):
        assert w.is_incomplete_day(self.EMP, "arrival", 9.0) is False

    def test_hours_none_is_incomplete(self):
        assert w.is_incomplete_day(self.EMP, "arrival", None) is True

    def test_no_employee_not_incomplete(self):
        # Другая причина для review — не incomplete_day
        assert w.is_incomplete_day(None, "arrival", None) is False

    def test_no_event_type_not_incomplete(self):
        assert w.is_incomplete_day(self.EMP, None, None) is False

    def test_zero_hours_complete(self):
        # 0 часов — странно, но hours не None → не incomplete
        assert w.is_incomplete_day(self.EMP, "departure", 0.0) is False


# ═══════════════════════════════════════════════════════════════════════════════
# parse_embedding
# ═══════════════════════════════════════════════════════════════════════════════

class TestParseEmbedding:
    def test_none(self):
        assert w.parse_embedding(None) is None

    def test_json_string(self):
        result = w.parse_embedding("[0.1, 0.2, 0.3]")
        assert list(result) == [0.1, 0.2, 0.3]

    def test_list(self):
        result = w.parse_embedding([1.0, 2.0])
        assert list(result) == [1.0, 2.0]

    def test_empty_string(self):
        with pytest.raises(Exception):
            w.parse_embedding("")
