"""India-specific reference data and open-standard alert interchange.

Everything here is static, offline reference material: a registry of flood-prone
Indian urban regions, emergency helplines, the India Meteorological Department
(IMD) and Central Water Commission (CWC) classification scales, and a Common
Alerting Protocol (CAP 1.2) serializer. CAP is the open OASIS standard used by
NDMA's SACHET platform, so a floodRISE alert can be handed to an Indian alerting
authority without a proprietary gateway.

Nothing in this module contacts IMD, CWC, NDMA, or any other provider. A region
being registered does not mean floodRISE holds data for it; ``data_status`` says
what is actually packaged.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from datetime import datetime
from typing import Any
from xml.etree import ElementTree
from zoneinfo import ZoneInfo

from .errors import AppError, NotFoundError

INDIA_TIMEZONE = "Asia/Kolkata"
IST = ZoneInfo(INDIA_TIMEZONE)
CAP_NAMESPACE = "urn:oasis:names:tc:emergency:cap:1.2"
CAP_MEDIA_TYPE = "application/cap+xml"

# Planning envelope for mainland India plus the island territories. Used only to
# reject obviously misplaced coordinates, never as an administrative boundary.
INDIA_BOUNDS = (68.0, 6.5, 97.5, 37.5)

# Bounding boxes are approximate planning envelopes around the urban area, not
# surveyed municipal boundaries. ``languages`` are BCP 47 tags in the order the
# field app should offer them.
_REGIONS: tuple[dict[str, Any], ...] = (
    {
        "id": "in-tn-chennai",
        "name": "Chennai",
        "state": "Tamil Nadu",
        "state_code": "IN-TN",
        "bounds": [80.12, 12.88, 80.31, 13.23],
        "center": [80.2707, 13.0827],
        "languages": ["ta", "en", "hi"],
        "river_basins": ["Adyar", "Cooum", "Kosasthalaiyar"],
        "flood_drivers": ["northeast monsoon", "cyclone", "reservoir release", "urban drainage"],
        "data_status": "DEMO_FIXTURE",
    },
    {
        "id": "in-mh-mumbai",
        "name": "Mumbai",
        "state": "Maharashtra",
        "state_code": "IN-MH",
        "bounds": [72.77, 18.89, 72.99, 19.27],
        "center": [72.8777, 19.076],
        "languages": ["mr", "hi", "en"],
        "river_basins": ["Mithi", "Dahisar", "Poisar", "Oshiwara"],
        "flood_drivers": ["southwest monsoon", "high tide", "urban drainage"],
        "data_status": "REGISTERED_NO_DATA",
    },
    {
        "id": "in-wb-kolkata",
        "name": "Kolkata",
        "state": "West Bengal",
        "state_code": "IN-WB",
        "bounds": [88.24, 22.45, 88.46, 22.66],
        "center": [88.3639, 22.5726],
        "languages": ["bn", "hi", "en"],
        "river_basins": ["Hooghly"],
        "flood_drivers": ["southwest monsoon", "cyclone", "high tide", "urban drainage"],
        "data_status": "REGISTERED_NO_DATA",
    },
    {
        "id": "in-as-guwahati",
        "name": "Guwahati",
        "state": "Assam",
        "state_code": "IN-AS",
        "bounds": [91.58, 26.07, 91.87, 26.22],
        "center": [91.7362, 26.1445],
        "languages": ["as", "hi", "en"],
        "river_basins": ["Brahmaputra", "Bharalu"],
        "flood_drivers": ["southwest monsoon", "riverine flood", "urban drainage"],
        "data_status": "REGISTERED_NO_DATA",
    },
    {
        "id": "in-br-patna",
        "name": "Patna",
        "state": "Bihar",
        "state_code": "IN-BR",
        "bounds": [85.03, 25.55, 85.27, 25.66],
        "center": [85.1376, 25.5941],
        "languages": ["hi", "en"],
        "river_basins": ["Ganga", "Punpun", "Son"],
        "flood_drivers": ["southwest monsoon", "riverine flood", "urban drainage"],
        "data_status": "REGISTERED_NO_DATA",
    },
    {
        "id": "in-kl-kochi",
        "name": "Kochi",
        "state": "Kerala",
        "state_code": "IN-KL",
        "bounds": [76.20, 9.89, 76.40, 10.08],
        "center": [76.2673, 9.9312],
        "languages": ["ml", "en", "hi"],
        "river_basins": ["Periyar", "Muvattupuzha"],
        "flood_drivers": ["southwest monsoon", "reservoir release", "high tide"],
        "data_status": "REGISTERED_NO_DATA",
    },
    {
        "id": "in-tg-hyderabad",
        "name": "Hyderabad",
        "state": "Telangana",
        "state_code": "IN-TG",
        "bounds": [78.30, 17.25, 78.62, 17.55],
        "center": [78.4867, 17.385],
        "languages": ["te", "ur", "hi", "en"],
        "river_basins": ["Musi"],
        "flood_drivers": ["southwest monsoon", "cloudburst", "lake overflow", "urban drainage"],
        "data_status": "REGISTERED_NO_DATA",
    },
    {
        "id": "in-ka-bengaluru",
        "name": "Bengaluru",
        "state": "Karnataka",
        "state_code": "IN-KA",
        "bounds": [77.46, 12.83, 77.78, 13.14],
        "center": [77.5946, 12.9716],
        "languages": ["kn", "en", "hi"],
        "river_basins": ["Vrishabhavathi", "Dakshina Pinakini"],
        "flood_drivers": ["pre-monsoon storm", "lake overflow", "urban drainage"],
        "data_status": "REGISTERED_NO_DATA",
    },
    {
        "id": "in-dl-delhi",
        "name": "Delhi",
        "state": "Delhi",
        "state_code": "IN-DL",
        "bounds": [76.84, 28.40, 77.35, 28.88],
        "center": [77.1025, 28.7041],
        "languages": ["hi", "en", "ur", "pa"],
        "river_basins": ["Yamuna"],
        "flood_drivers": ["southwest monsoon", "riverine flood", "barrage release"],
        "data_status": "REGISTERED_NO_DATA",
    },
    {
        "id": "in-gj-surat",
        "name": "Surat",
        "state": "Gujarat",
        "state_code": "IN-GJ",
        "bounds": [72.74, 21.10, 72.94, 21.28],
        "center": [72.8311, 21.1702],
        "languages": ["gu", "hi", "en"],
        "river_basins": ["Tapi"],
        "flood_drivers": ["southwest monsoon", "reservoir release", "high tide"],
        "data_status": "REGISTERED_NO_DATA",
    },
    {
        "id": "in-od-cuttack-bhubaneswar",
        "name": "Cuttack–Bhubaneswar",
        "state": "Odisha",
        "state_code": "IN-OD",
        "bounds": [85.72, 20.20, 85.96, 20.52],
        "center": [85.8245, 20.2961],
        "languages": ["or", "hi", "en"],
        "river_basins": ["Mahanadi", "Kathajodi", "Kuakhai"],
        "flood_drivers": ["southwest monsoon", "cyclone", "riverine flood"],
        "data_status": "REGISTERED_NO_DATA",
    },
    {
        "id": "in-jk-srinagar",
        "name": "Srinagar",
        "state": "Jammu and Kashmir",
        "state_code": "IN-JK",
        "bounds": [74.72, 34.00, 74.92, 34.18],
        "center": [74.7973, 34.0837],
        "languages": ["ks", "ur", "hi", "en"],
        "river_basins": ["Jhelum"],
        "flood_drivers": ["western disturbance", "riverine flood", "snowmelt"],
        "data_status": "REGISTERED_NO_DATA",
    },
)

# Helplines change and are sometimes routed differently by telecom circle. Every
# entry therefore requires verification by the deploying authority; the app must
# never present this list as a guarantee of service.
_NATIONAL_CONTACTS: tuple[dict[str, Any], ...] = (
    {
        "id": "erss-112",
        "number": "112",
        "name": "Emergency Response Support System",
        "purpose": "Single national emergency number: police, fire, and ambulance",
        "scope": "NATIONAL",
        "priority": 1,
    },
    {
        "id": "ndma-1078",
        "number": "1078",
        "name": "NDMA disaster helpline",
        "purpose": "National Disaster Management Authority control room",
        "scope": "NATIONAL",
        "priority": 2,
    },
    {
        "id": "state-1070",
        "number": "1070",
        "name": "State emergency operations centre",
        "purpose": "State disaster control room",
        "scope": "STATE",
        "priority": 3,
    },
    {
        "id": "district-1077",
        "number": "1077",
        "name": "District emergency operations centre",
        "purpose": "District disaster control room",
        "scope": "DISTRICT",
        "priority": 4,
    },
    {
        "id": "ambulance-108",
        "number": "108",
        "name": "Emergency ambulance",
        "purpose": "Medical emergency and ambulance service",
        "scope": "NATIONAL",
        "priority": 5,
    },
    {
        "id": "fire-101",
        "number": "101",
        "name": "Fire and rescue",
        "purpose": "Fire service and rescue",
        "scope": "NATIONAL",
        "priority": 6,
    },
    {
        "id": "police-100",
        "number": "100",
        "name": "Police",
        "purpose": "Police control room",
        "scope": "NATIONAL",
        "priority": 7,
    },
    {
        "id": "women-1091",
        "number": "1091",
        "name": "Women helpline",
        "purpose": "Women in distress",
        "scope": "NATIONAL",
        "priority": 8,
    },
    {
        "id": "child-1098",
        "number": "1098",
        "name": "Childline",
        "purpose": "Children in need of care and protection",
        "scope": "NATIONAL",
        "priority": 9,
    },
)

_REGION_CONTACTS: dict[str, tuple[dict[str, Any], ...]] = {
    "in-tn-chennai": (
        {
            "id": "gcc-1913",
            "number": "1913",
            "name": "Greater Chennai Corporation helpline",
            "purpose": "Civic complaints including waterlogging",
            "scope": "CITY",
            "priority": 3,
        },
    ),
    "in-mh-mumbai": (
        {
            "id": "bmc-1916",
            "number": "1916",
            "name": "BMC disaster management helpline",
            "purpose": "Municipal disaster control room",
            "scope": "CITY",
            "priority": 3,
        },
    ),
}

# IMD 24-hour rainfall intensity terminology, in millimetres. Each tuple is the
# inclusive lower bound of the category.
_RAINFALL_CATEGORIES: tuple[tuple[float, str, str], ...] = (
    (204.5, "EXTREMELY_HEAVY", "Extremely heavy rainfall"),
    (115.6, "VERY_HEAVY", "Very heavy rainfall"),
    (64.5, "HEAVY", "Heavy rainfall"),
    (15.6, "MODERATE", "Moderate rainfall"),
    (2.5, "LIGHT", "Light rainfall"),
    (0.1, "VERY_LIGHT", "Very light rainfall"),
    (0.0, "NO_RAIN", "No rain"),
)

_IMD_COLOUR_CODES: tuple[dict[str, str], ...] = (
    {"code": "GREEN", "meaning": "No warning", "action": "No action required"},
    {"code": "YELLOW", "meaning": "Watch", "action": "Be updated"},
    {"code": "ORANGE", "meaning": "Alert", "action": "Be prepared"},
    {"code": "RED", "meaning": "Warning", "action": "Take action"},
)

_CWC_CATEGORIES: tuple[dict[str, str], ...] = (
    {"code": "NORMAL", "definition": "Water level below the warning level"},
    {
        "code": "ABOVE_NORMAL",
        "definition": "At or above the warning level and below the danger level",
    },
    {
        "code": "SEVERE",
        "definition": "At or above the danger level and below the highest flood level",
    },
    {"code": "EXTREME", "definition": "At or above the previous highest flood level"},
)

_SCALE_NOTICE = (
    "Reference scales only. floodRISE does not issue IMD or CWC warnings; follow the "
    "bulletin published by the responsible authority."
)


def _region_view(region: Mapping[str, Any]) -> dict[str, Any]:
    return {
        **region,
        "country": "IN",
        "timezone": INDIA_TIMEZONE,
        "bounds_kind": "APPROXIMATE_PLANNING_ENVELOPE",
    }


def list_regions() -> list[dict[str, Any]]:
    return [_region_view(region) for region in _REGIONS]


def get_region(region_id: str) -> dict[str, Any]:
    for region in _REGIONS:
        if region["id"] == region_id:
            return _region_view(region)
    raise NotFoundError("region", region_id)


def region_for_point(latitude: float, longitude: float) -> dict[str, Any] | None:
    """Return the registered region whose planning envelope contains the point."""

    for region in _REGIONS:
        west, south, east, north = region["bounds"]
        if west <= longitude <= east and south <= latitude <= north:
            return _region_view(region)
    return None


def point_in_india(latitude: float, longitude: float) -> bool:
    west, south, east, north = INDIA_BOUNDS
    return west <= longitude <= east and south <= latitude <= north


def emergency_contacts(region_id: str | None = None) -> list[dict[str, Any]]:
    """National helplines, plus city helplines when a region is given."""

    contacts = list(_NATIONAL_CONTACTS)
    if region_id is not None:
        get_region(region_id)
        contacts.extend(_REGION_CONTACTS.get(region_id, ()))
    return [
        {**contact, "tel_uri": f"tel:{contact['number']}", "requires_local_verification": True}
        for contact in sorted(contacts, key=lambda item: (item["priority"], item["id"]))
    ]


def classify_rainfall(mm_24h: float) -> dict[str, Any]:
    """Classify a 24-hour accumulation using IMD intensity terminology."""

    if not math.isfinite(mm_24h) or mm_24h < 0:
        raise AppError(
            status_code=422,
            title="Invalid rainfall amount",
            detail="mm_24h must be a finite, non-negative number of millimetres.",
            code="INVALID_RAINFALL",
        )
    # IMD reports to one decimal place; compare at that precision so 64.45 and
    # 64.5 do not straddle a category because of float representation.
    amount = round(mm_24h, 1)
    for lower_bound, code, label in _RAINFALL_CATEGORIES:
        if amount >= lower_bound:
            return {"mm_24h": amount, "category": code, "label": label, "basis": "IMD 24-hour"}
    raise AssertionError("rainfall categories must cover every non-negative amount")


def classify_river_level(
    level_m: float, *, warning_m: float, danger_m: float, hfl_m: float
) -> dict[str, Any]:
    """Classify a gauge reading using CWC flood-situation categories."""

    values = (level_m, warning_m, danger_m, hfl_m)
    if not all(math.isfinite(value) for value in values) or not warning_m < danger_m <= hfl_m:
        raise AppError(
            status_code=422,
            title="Invalid gauge thresholds",
            detail="Levels must be finite with warning < danger <= highest flood level.",
            code="INVALID_GAUGE_THRESHOLDS",
        )
    if level_m >= hfl_m:
        category = "EXTREME"
    elif level_m >= danger_m:
        category = "SEVERE"
    elif level_m >= warning_m:
        category = "ABOVE_NORMAL"
    else:
        category = "NORMAL"
    return {
        "level_m": level_m,
        "category": category,
        "margin_to_danger_m": round(danger_m - level_m, 3),
        "basis": "CWC flood situation",
    }


def warning_scales() -> dict[str, Any]:
    ordered = sorted(_RAINFALL_CATEGORIES)
    return {
        "notice": _SCALE_NOTICE,
        "imd_colour_codes": list(_IMD_COLOUR_CODES),
        "imd_rainfall_24h_mm": [
            {
                "category": code,
                "label": label,
                "min_mm": lower,
                "max_mm": round(ordered[index + 1][0] - 0.1, 1)
                if index + 1 < len(ordered)
                else None,
            }
            for index, (lower, code, label) in enumerate(ordered)
        ],
        "cwc_flood_situation": list(_CWC_CATEGORIES),
    }


def _cap_time(value: str | datetime) -> str:
    """CAP 1.2 requires an explicit numeric offset and forbids the ``Z`` suffix."""

    moment = (
        value
        if isinstance(value, datetime)
        else datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    )
    return moment.astimezone(IST).isoformat(timespec="seconds")


def _cap_circle(geometry: Any, radius_km: float) -> str | None:
    if not isinstance(geometry, Mapping):
        return None
    try:
        latitude = float(geometry["latitude"])
        longitude = float(geometry["longitude"])
    except (KeyError, TypeError, ValueError):
        return None
    if not (math.isfinite(latitude) and math.isfinite(longitude)):
        return None
    return f"{latitude:.5f},{longitude:.5f} {radius_km:g}"


def alert_to_cap(
    alert: Mapping[str, Any],
    *,
    sender: str,
    sender_name: str,
    area_description: str,
) -> bytes:
    """Serialize a floodRISE alert as a CAP 1.2 document.

    Demo alerts are emitted with ``status`` ``Exercise`` so a receiving
    aggregator can never mistake a replay for an actual public warning. A
    community caution is unofficial evidence, so it is marked ``Possible``
    and carries ``floodrise:official`` ``false``.
    """

    official = bool(alert.get("official"))
    is_demo = bool(alert.get("is_demo", True))

    def child(parent: ElementTree.Element, tag: str, text: str) -> ElementTree.Element:
        element = ElementTree.SubElement(parent, f"{{{CAP_NAMESPACE}}}{tag}")
        element.text = text
        return element

    def parameter(parent: ElementTree.Element, name: str, value: Any) -> None:
        if value in (None, ""):
            return
        node = ElementTree.SubElement(parent, f"{{{CAP_NAMESPACE}}}parameter")
        child(node, "valueName", name)
        child(node, "value", str(value))

    ElementTree.register_namespace("", CAP_NAMESPACE)
    root = ElementTree.Element(f"{{{CAP_NAMESPACE}}}alert")
    child(root, "identifier", str(alert["id"]))
    child(root, "sender", sender)
    child(root, "sent", _cap_time(alert.get("dispatched_at") or alert["created_at"]))
    child(root, "status", "Exercise" if is_demo else "Actual")
    child(root, "msgType", "Alert")
    child(root, "scope", "Public")
    if is_demo:
        child(root, "note", "DEMO DATA exercise message. Not an actual public warning.")

    info = ElementTree.SubElement(root, f"{{{CAP_NAMESPACE}}}info")
    child(info, "language", "en-IN")
    child(info, "category", "Met")
    child(info, "event", "Flood")
    child(info, "responseType", "Avoid" if official else "Monitor")
    child(info, "urgency", "Immediate" if official else "Expected")
    child(info, "severity", "Severe" if official else "Moderate")
    child(info, "certainty", "Likely" if official else "Possible")
    if alert.get("expires_at"):
        child(info, "expires", _cap_time(alert["expires_at"]))
    child(info, "senderName", sender_name)
    child(info, "headline", str(alert.get("title", "Flood alert"))[:160])
    child(info, "description", str(alert.get("body", "")))
    child(
        info,
        "instruction",
        "Do not enter floodwater. Follow instructions from authorized emergency officials. "
        "In an emergency call 112.",
    )
    parameter(info, "floodrise:official", str(official).lower())
    parameter(info, "floodrise:is_simulated", str(is_demo).lower())
    parameter(info, "floodrise:evidence_version", alert.get("evidence_version"))
    parameter(info, "floodrise:model_version", alert.get("model_version"))
    parameter(info, "floodrise:audience", alert.get("audience"))

    area = ElementTree.SubElement(info, f"{{{CAP_NAMESPACE}}}area")
    child(area, "areaDesc", area_description)
    circle = _cap_circle(alert.get("geometry"), 1.0)
    if circle:
        child(area, "circle", circle)

    return ElementTree.tostring(root, encoding="utf-8", xml_declaration=True)


__all__ = [
    "CAP_MEDIA_TYPE",
    "CAP_NAMESPACE",
    "INDIA_BOUNDS",
    "INDIA_TIMEZONE",
    "alert_to_cap",
    "classify_rainfall",
    "classify_river_level",
    "emergency_contacts",
    "get_region",
    "list_regions",
    "point_in_india",
    "region_for_point",
    "warning_scales",
]
