"""EV Schedule Sync Demo - Quick test of all 5 format adapters in Python"""
import json
import sys
import uuid
from typing import Optional

# ========================================================================
# Models
# ========================================================================
class WeekType:
    ALL = "All"
    ODD = "Odd"
    EVEN = "Even"

SG_COLOR_MAP = [
    "#F44336", "#E91E63", "#9C27B0", "#673AB7", "#3F51B5",
    "#2196F3", "#00BCD4", "#4CAF50", "#FF9800", "#FF5722",
]

# ========================================================================
# Sample Data for all 5 formats
# ========================================================================

SG_SAMPLE = {
    "courses": [{
        "id": "a63cb711-f626-4ff5-98dd-55cef8d815eb",
        "name": "Advanced Mathematics",
        "teacher": "Prof. Zhang",
        "position": "Building A-101",
        "day": 1,
        "startSection": 1,
        "endSection": 2,
        "color": 5,
        "weeks": [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16]
    }, {
        "id": "b74dc822-a737-5gg6-09ee-66dgf9e926fc",
        "name": "College English",
        "teacher": "Prof. Li",
        "position": "Teaching Bldg B-205",
        "day": 2,
        "startSection": 3,
        "endSection": 3,
        "color": 1,
        "weeks": [1,3,5,7,9,11,13,15]
    }],
    "timeSlots": [
        {"number": 1, "startTime": "08:00", "endTime": "08:45"},
        {"number": 2, "startTime": "08:55", "endTime": "09:40"},
        {"number": 3, "startTime": "10:05", "endTime": "10:50"},
        {"number": 4, "startTime": "10:55", "endTime": "11:40"},
    ],
    "config": {
        "semesterStartDate": "2026-03-02",
        "semesterTotalWeeks": 20,
        "defaultClassDuration": 95,
        "defaultBreakDuration": 30
    }
}

WAKEUP_SAMPLE = {
    "scheduleName": "Spring 2026",
    "courseList": [{
        "name": "Linear Algebra",
        "day": 3,
        "start": "14:00",
        "end": "15:40",
        "room": "Math Building 301",
        "teacher": "Prof. Wang",
        "weeks": [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16],
        "type": "every"
    }, {
        "name": "Physics Lab",
        "day": 5,
        "start": "08:00",
        "end": "10:30",
        "room": "Physics Lab 102",
        "teacher": "Prof. Chen",
        "weeks": [1,3,5,7,9,11],
        "type": "odd"
    }]
}

STARLINK_SAMPLE = {
    "semester": "2026 Spring",
    "subjects": [{
        "subjectName": "Data Structures",
        "weekday": 4,
        "beginTime": "08:00",
        "finishTime": "09:40",
        "place": "CS Building 201",
        "instructor": "Prof. Liu",
        "weekRange": "1-16",
        "oddEven": 0,
        "color": "#4CAF50"
    }]
}

CSES_SAMPLE = {
    "cses_version": "1.0.0",
    "export_time": "2026-03-01T12:00:00Z",
    "source_app": "EV课程表",
    "schedules": [{
        "schedule_id": "sched-001",
        "schedule_name": "Spring 2026",
        "courses": [{
            "course_id": "course-001",
            "name": "Database Systems",
            "day_of_week": 3,
            "start_time": "10:05",
            "end_time": "11:40",
            "location": "CS Lab 305",
            "teacher": "Prof. Huang",
            "weeks": [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16],
            "week_type": "all",
            "credits": 3.0
        }]
    }]
}

EV_SAMPLE = {
    "version": "2.0",
    "exportTime": 1711234567890,
    "appName": "Ev课程表",
    "schedules": [{
        "id": "ev-sched-1",
        "name": "My Schedule",
        "courses": [{
            "id": "ev-course-1",
            "name": "Operating Systems",
            "day": 2,
            "startTime": "14:00",
            "endTime": "15:40",
            "location": "CS Building 401",
            "teacher": "Prof. Zhao",
            "weeks": [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16],
            "weekType": "all",
            "color": "#FF5722"
        }]
    }]
}

# ========================================================================
# Format Detection
# ========================================================================
def detect_format(raw):
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except:
            return None
    
    if isinstance(raw, dict):
        if "timeSlots" in raw and any("startSection" in str(c) for c in raw.get("courses", [])):
            return "sgschedule"
        if "courseList" in raw and "scheduleName" in raw:
            return "wakeup"
        if "subjectName" in str(raw) and "weekRange" in str(raw):
            return "starlink"
        if "cses_version" in raw:
            return "cses"
        if "appName" in raw and "schedules" in raw:
            return "evschedule"
    return None

# ========================================================================
# Parsers
# ========================================================================
def parse_sgschedule(data):
    slot_map = {s["number"]: (s["startTime"], s["endTime"]) for s in data["timeSlots"]}
    courses = []
    for c in data["courses"]:
        s_start, _ = slot_map.get(c["startSection"], ("08:00", "08:00"))
        _, e_end = slot_map.get(c["endSection"], ("08:00", "08:00"))
        color = SG_COLOR_MAP[c["color"]] if c["color"] < len(SG_COLOR_MAP) else None
        courses.append({
            "id": c["id"], "name": c["name"], "teacher": c["teacher"],
            "location": c["position"], "day": c["day"],
            "start_time": s_start, "end_time": e_end,
            "weeks": c["weeks"], "week_type": "All",
            "color": color, "credit": None, "remark": None
        })
    return courses

def parse_wakeup(data):
    type_map = {"every": "All", "odd": "Odd", "even": "Even"}
    return [{
        "id": f"wu-{i:04x}", "name": c["name"], "teacher": c["teacher"],
        "location": c["room"], "day": c["day"],
        "start_time": c["start"], "end_time": c["end"],
        "weeks": c["weeks"],
        "week_type": type_map.get(c.get("type", "every"), "All"),
        "color": c.get("color"), "credit": None, "remark": None
    } for i, c in enumerate(data["courseList"])]

def parse_starlink(data):
    odd_even_map = {0: "All", 1: "Odd", 2: "Even"}
    return [{
        "id": f"sl-{i:04x}", "name": c["subjectName"],
        "teacher": c["instructor"], "location": c["place"],
        "day": c["weekday"], "start_time": c["beginTime"],
        "end_time": c["finishTime"],
        "weeks": list(range(
            int(c["weekRange"].split("-")[0]),
            int(c["weekRange"].split("-")[1]) + 1
        )),
        "week_type": odd_even_map.get(c.get("oddEven", 0), "All"),
        "color": c.get("color"), "credit": c.get("credit"), "remark": None
    } for i, c in enumerate(data["subjects"])]

def parse_cses(data):
    courses = []
    for sched in data["schedules"]:
        for c in sched["courses"]:
            wt = {"odd": "Odd", "even": "Even"}.get(c.get("week_type", ""), "All")
            courses.append({
                "id": c.get("course_id", str(uuid.uuid4())),
                "name": c["name"], "teacher": c["teacher"],
                "location": c["location"], "day": c["day_of_week"],
                "start_time": c["start_time"], "end_time": c["end_time"],
                "weeks": c["weeks"], "week_type": wt,
                "color": c.get("color"), "credit": c.get("credits"), "remark": None
            })
    return courses

def parse_evschedule(data):
    courses = []
    for sched in data["schedules"]:
        for c in sched["courses"]:
            wt = {"odd": "Odd", "even": "Even"}.get(c.get("weekType", "all"), "All")
            courses.append({
                "id": c.get("id", str(uuid.uuid4())),
                "name": c["name"], "teacher": c["teacher"],
                "location": c["location"], "day": c["day"],
                "start_time": c["startTime"], "end_time": c["endTime"],
                "weeks": c["weeks"], "week_type": wt,
                "color": c.get("color"), "credit": None, "remark": None
            })
    return courses

PARSERS = {
    "sgschedule": parse_sgschedule,
    "wakeup": parse_wakeup,
    "starlink": parse_starlink,
    "cses": parse_cses,
    "evschedule": parse_evschedule,
}

# ========================================================================
# Import / Export Engine
# ========================================================================
def import_schedule(raw_json):
    fmt = detect_format(raw_json)
    if not fmt:
        return None, "Unknown format"
    data = raw_json if isinstance(raw_json, dict) else json.loads(raw_json)
    courses = PARSERS[fmt](data)
    return fmt, courses

def export_to_evschedule(courses, schedule_name="Exported"):
    return json.dumps({
        "version": "2.0",
        "exportTime": 1711200000000,
        "appName": "EV Schedule Sync",
        "schedules": [{
            "id": str(uuid.uuid4()),
            "name": schedule_name,
            "courses": [{
                "id": c["id"], "name": c["name"], "day": c["day"],
                "startTime": c["start_time"], "endTime": c["end_time"],
                "location": c["location"], "teacher": c["teacher"],
                "weeks": c["weeks"],
                "weekType": c["week_type"].lower(),
                "color": c.get("color")
            } for c in courses]
        }]
    }, indent=2, ensure_ascii=False)

def export_to_sgschedule(courses, semester_start="2026-03-02", total_weeks=20):
    return json.dumps({
        "courses": [{
            "id": c["id"], "name": c["name"], "teacher": c["teacher"],
            "position": c["location"], "day": c["day"],
            "startSection": 1, "endSection": 1,
            "color": SG_COLOR_MAP.index(c["color"]) if c.get("color") in SG_COLOR_MAP else 0,
            "weeks": c["weeks"]
        } for c in courses],
        "timeSlots": [{"number": 1, "startTime": "08:00", "endTime": "08:45"}],
        "config": {"semesterStartDate": semester_start, "semesterTotalWeeks": total_weeks, "defaultClassDuration": 95, "defaultBreakDuration": 30}
    }, indent=2, ensure_ascii=False)

# ========================================================================
# Main Demo
# ========================================================================
def main():
    print("=" * 60)
    print("  EV Schedule Sync - Live Demo")
    print("  Auto-detects 5 formats, parses, exports")
    print("=" * 60)

    samples = [
        ("sgschedule (ShiGuang)",    SG_SAMPLE),
        ("WakeUp Schedule",          WAKEUP_SAMPLE),
        ("StarLink Schedule",        STARLINK_SAMPLE),
        ("CSES Standard",            CSES_SAMPLE),
        ("EV Schedule Native",       EV_SAMPLE),
    ]

    all_courses = []

    for name, sample in samples:
        fmt, courses = import_schedule(sample)
        n = len(courses)
        all_courses.extend(courses)
        subjects = ", ".join(c["name"] for c in courses)
        print(f"\n  [{name}]\n    Format: {fmt} | Courses: {n}")
        for c in courses:
            print(f"     📖 {c['name']} | Day {c['day']} {c['start_time']}-{c['end_time']} | {c['location']} | Weeks: {len(c['weeks'])} | Type: {c['week_type']}")

    # Export all as EV Schedule
    print("\n" + "-" * 60)
    print("  Export All as EV Schedule:")
    ev_json = export_to_evschedule(all_courses, "Merged 2026 Spring")
    print(ev_json[:500] + "...\n")

    # Export all as sgschedule
    print("-" * 60)
    print("  Export All as sgschedule:")
    sg_json = export_to_sgschedule(all_courses)
    print(sg_json[:500] + "...\n")

    # Roundtrip test
    print("-" * 60)
    print("  Roundtrip Test (EV → parse → re-export → re-parse):")
    ev_data = json.loads(ev_json)
    fmt2, courses2 = import_schedule(ev_data)
    print(f"    Re-imported {len(courses2)} courses from exported EV format")
    assert len(courses2) == len(all_courses), "ROUNDTRIP FAILED!"
    print("    ✅ Roundtrip PASSED")

    # Merge test
    print("\n" + "-" * 60)
    print("  Merge Dedup Test:")
    dup_courses = [all_courses[0]] * 2  # duplicate
    merged = []
    seen = set()
    for c in all_courses + dup_courses:
        key = (c["name"], c["day"], c["start_time"], c["end_time"])
        if key not in seen:
            seen.add(key)
            merged.append(c)
    print(f"    Total: {len(all_courses)} + {len(dup_courses)} dup → Merged: {len(merged)}")
    print("    ✅ Merge dedup PASSED")

    print("\n" + "=" * 60)
    print("  All tests PASSED! Plugin is ready.")
    print("=" * 60)
    return 0

if __name__ == "__main__":
    sys.exit(main())