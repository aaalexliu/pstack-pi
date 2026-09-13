---
name: setup-pstack
description: Configure exact Pi models for pstack delegation roles. Use for setup pstack, configure pstack models, or change role routing.
disable-model-invocation: true
---

# Setup pstack

Write `<Pi agent dir>/pstack-pi/models.json`, the strict role config used before each spawn.

1. Call `pstack_config` with `action: "list-models"`. Never write a model selector absent from that result. `inherit-parent` is always valid.
2. Call `pstack_config` with `action: "get"` to read current assignments.
3. Show invalid or missing choices. Ask only which model policy the user prefers. Start unconfigured roles at `inherit-parent`.
4. Write this exact versioned shape with JSON strings or nonempty arrays:

```json
{"version":1,"roles":{"feature":"inherit-parent","review":["provider/model-a","provider/model-b"]}}
```

5. Use only role names listed by the `subagent` tool schema. Arrays define deterministic round-robin pools. Duplicate entries are meaningful and remain.
6. Create the `pstack-pi` directory under the Pi agent directory if needed. The directory and file must be owned by the current user, regular files rather than links, and not group- or world-writable.
7. Call `pstack_config` with `action: "get"` again. Fix any parse or safety error before reporting success.

The config is user-level, not project configuration. Do not commit it. New subagent requests read it before admission.
