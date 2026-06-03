# Franklin — Home Assistant Guide

Read this file when `"hassio"` is in `integrations`. Covers discovery, querying, and control of smart home devices.

---

## What It Is

`hassio` is an agent-optimized CLI for the Home Assistant REST + WebSocket API. It can read sensor states, toggle switches/lights, control climate, inspect devices, and call any HA service. Auth is via `HASSIO_URL` and `HASSIO_TOKEN` env vars — already set, no config needed.

## Discovery Workflow

Don't guess entity IDs. Discover what's available:

```bash
# 1. See what domains exist and their counts
hassio entities --domains --format toon

# 2. List entities in a domain
hassio entities --domain switch --format toon
hassio entities --domain light --format toon
hassio entities --domain sensor --format toon

# 3. Inspect an entity for full details (attributes, state, last changed)
hassio inspect switch.garage_light --format toon
```

To find what physical devices are registered (manufacturer, model, area):

```bash
hassio registries --devices --format toon
```

Entity state alone won't tell you a switch is a TP-Link HS200 in the garage — the device registry will.

## Key Commands by Domain

Always use `--format toon` for output. It's the most token-efficient format.

### Switches & Lights

```bash
hassio switch on switch.garage_light
hassio switch off switch.garage_light
hassio switch toggle switch.garage_light
hassio light on light.living_room --brightness 128
```

### Sensors & Binary Sensors (read-only)

```bash
hassio entities --domain sensor --format toon
hassio entities --domain binary_sensor --format toon
hassio sensor --format toon              # browse all sensors
```

### Climate (thermostats, AC)

```bash
hassio climate --format toon             # list all
hassio climate set climate.living_room --temperature 72
hassio climate set_hvac_mode climate.living_room --mode heat
```

### Covers (blinds, garage doors)

```bash
hassio cover open cover.garage_door
hassio cover close cover.garage_door
```

### Device Trackers & Persons

```bash
hassio device-tracker --format toon
hassio persons --format toon
```

### Weather & Sun

```bash
hassio weather --format toon
hassio sun --format toon
```

### Query (LLM-friendly search)

```bash
hassio query "lights that are on" --format toon
hassio query "temperature sensors" --format toon
```

## Service Calls

For anything not covered by a domain subcommand, call the HA service directly:

```bash
hassio services --format toon              # list all available services
hassio call-service light turn_on --params '{"entity_id": "light.living_room", "brightness": 128}'
```

## Safety Rules

- **Read-only by default** — `entities`, `inspect`, `registries`, `query`, `sensor`, `weather`, `sun`, `persons`, `device-tracker` are always safe
- **Write operations** (toggle, set, call-service, set-state) require the quest objective to explicitly require it AND user approval
- **Use `--read-only` flag** when exploring unfamiliar domains — it blocks all state-changing calls at the CLI level
- **Batch cautiously** — `hassio batch` can chain multiple service calls. Review the full batch before running
- **Log all HA usage** in the quest log with `action: "info_received"` and `platform: "hassio"`

## Quick Reference

| Task | Command |
|---|---|
| What's in my house? | `hassio registries --devices --format toon` |
| What domains exist? | `hassio entities --domains --format toon` |
| List switches | `hassio entities --domain switch --format toon` |
| Inspect entity | `hassio inspect <entity_id> --format toon` |
| Toggle a switch | `hassio switch toggle <entity_id>` |
| Set thermostat | `hassio climate set <entity_id> --temperature 72` |
| Find by name | `hassio query "garage" --format toon` |
| System info | `hassio info --format toon` |
