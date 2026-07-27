# Tools

Sixteen tool definitions exist. How many are **registered** depends on your
configuration:

| Configuration | Registered |
|---|---|
| Default | **15** — everything except `execute_destructive_operation` |
| `COOLIFY_ALLOW_DESTRUCTIVE=true` (and a connection that allows it) | **16** |
| `COOLIFY_READ_ONLY=true`, or every connection `readOnly` | **11** — the read surface only |

A tool that is not registered does not appear in `tools/list` at all. It is never
listed-and-refusing.

## The table

| Tool | Class | Coolify ability | Backing call |
|---|---|---|---|
| `find_resources` | read | `read` | `GET /resources` (once per targeted connection) |
| `get_resource` | read | `read` | `GET /{family}/{uuid}` |
| `get_logs` | read | **`read:sensitive`** | `GET /{family}/{uuid}/logs` |
| `get_environment_variables` | read | **`read:sensitive`** | `GET /{family}/{uuid}/envs` |
| `list_deployments` | read | `read` | `GET /deployments` or `GET /deployments/applications/{uuid}` |
| `get_deployment` | read | `read` (build log content needs `read:sensitive`) | `GET /deployments/{uuid}` |
| `list_servers` | read | `read` | `GET /servers` |
| `list_projects` | read | `read` | `GET /projects` |
| `search_operations` | read | none | local catalog, no network |
| `describe_operation` | read | none | local catalog, no network |
| `execute_read_operation` | read | `read`, or `read:sensitive` on `/logs` and `/envs` | any catalogued GET |
| `deploy` | write | `deploy` | `POST /deploy` (+ polling reads with `wait`) |
| `control_resource` | write | `write` | `POST /{family}/{uuid}/{start\|stop\|restart}` |
| `set_environment_variables` | write | `write` | `PATCH /{family}/{uuid}/envs/bulk` |
| `execute_write_operation` | write | `write` | any catalogued POST / PATCH / PUT |
| `execute_destructive_operation` | **destructive** | `write` (or `root`) | any catalogued DELETE, plus `POST /disable` |

`{family}` is `applications`, `databases` or `services`, chosen by the
`resource_type` parameter.

Every tool carries `openWorldHint: true` except `search_operations` and
`describe_operation`, which read a catalog compiled into the package — no
network, no external entity, a fixed and fully known domain.

---

## Read tools

### `find_resources`

The entry point. Coolify UUIDs are short opaque strings that appear nowhere in a
conversation until something lists them, so without this the model holds a set of
resource tools it can never call.

Backed by `GET /resources`, which returns applications, databases *and* services
in **one** request — cheaper than the three list calls it replaces, and the reason
there is no `list_applications` / `list_databases` / `list_services`.

| Parameter | Type | Notes |
|---|---|---|
| `query` | string ≤200 | Case-insensitive substring against name, uuid, fqdn, description, project name, environment name and server name. |
| `resource_type` | `application` \| `database` \| `service` | Coolify types databases by engine (`standalone-postgresql`), so every `standalone-*` type is classified as `database`. |
| `status` | string ≤60 | Case-insensitive substring against the status string. |
| `limit` | int 1–200 | Default 50. |
| `cursor` | string | From a previous call's `meta.next_cursor`. |
| `instance` | enum | Present only with >1 connection. Accepts `"*"`. |

Returns nine columns per row: `uuid`, `name`, `type`, `status`, `fqdn`,
`project_name`, `environment_name`, `server_name`, `updated_at` — out of roughly
eighty Coolify returns. With `instance: "*"` an `instance` column leads.

**`instance: "*"` is unique to this tool.** It queries every configured connection
in parallel and tags each row with its origin. Safe to fan out precisely because
the tool cannot write. Per-connection failures land in `meta.errors[]`; when
*every* connection fails the result is marked `isError`, because an empty list
would read as "no resources" rather than "nothing answered".

### `get_resource`

The complete stored configuration of one resource: build settings, domains,
ports, health checks, git source, server placement, timestamps.

| Parameter | Type | Notes |
|---|---|---|
| `resource_type` | enum | **Required** — a Coolify uuid does not say which family it is in, and the wrong family returns 404. |
| `uuid` | string | From `find_resources`. |
| `instance` | enum | Present only with >1 connection. |

Values under credential-shaped keys are masked **unconditionally** — there is no
`reveal` here. Environment variables are not included; they have their own tool.

### `get_logs`

Container runtime logs. ANSI colour codes are stripped (Coolify build output is
full of them; they are zero information to a model and real token cost), and the
output is trimmed **from the front** so the newest lines always survive.

| Parameter | Type | Notes |
|---|---|---|
| `resource_type` | enum | Required. |
| `uuid` | string | Required. |
| `lines` | int 1–5000 | Default 200. Additionally capped at 60,000 bytes. |
| `show_timestamps` | boolean | Off by default — timestamps roughly double the payload. |
| `sub_service_name` | string ≤200 | Names one container inside a service. |
| `instance` | enum | Present only with >1 connection. |

**The error path that matters.** Reading logs needs `read:sensitive`. A token
without it does not get a 403 — Coolify answers **200 with an empty body**. Left
undetected that surfaces as "the logs are empty" and the issue tracker fills with
reports that have nothing to do with logging. So an empty body on a 200 is
treated as a failure and named. Because a stopped container legitimately produces
no output, the message states both possibilities rather than asserting a
permission problem it cannot confirm.

These are **runtime** logs. Build and deploy output — why a deployment failed —
is in `get_deployment`.

### `get_environment_variables`

| Parameter | Type | Notes |
|---|---|---|
| `resource_type` | enum | Required. |
| `uuid` | string | Required. |
| `reveal` | boolean | Default false. Values are masked; keys, flags and timestamps are always shown. |
| `instance` | enum | Present only with >1 connection. |

Rows are sorted by key rather than left in Coolify's creation order, because an
environment is read by scanning for a name.

An empty result is not an error — plenty of resources genuinely have no variables
— but a token without `read:sensitive` produces a thin result here too, so the
hint says both.

### `list_deployments`

| Parameter | Type | Notes |
|---|---|---|
| `application_uuid` | string | **Changes what the tool does.** Without it: deployments in progress *right now*. With it: that application's history, newest first. |
| `limit` | int 1–100 | Default 20. |
| `cursor` | string | From `meta.next_cursor`. |
| `instance` | enum | Present only with >1 connection. |

Build logs are stripped from these rows — a single one can be megabytes.
`get_deployment` returns a bounded log tail for one deployment.

With `application_uuid` this uses `GET /deployments/applications/{uuid}?skip&take`,
the one upstream endpoint with real pagination, so no full history is ever pulled
into memory. Upstream reports no total, so "there is more" is inferred from a
full page — one wasted call at the exact end of the history is the price.

### `get_deployment`

One deployment plus a bounded tail of its build log — the record that says why a
deployment failed.

| Parameter | Type | Notes |
|---|---|---|
| `uuid` | string | The `deployment_uuid` from `list_deployments`, **not** the application uuid. |
| `log_lines` | int 0–5000 | Default 200. `0` omits the log and returns the record alone. |
| `instance` | enum | Present only with >1 connection. |

### `list_servers`

Only `instance`. Returns each server with the reachability and usability flags
lifted out of the settings relation, so a broken server is visible at a glance;
the hint counts how many report `is_reachable: false`.

### `list_projects`

Only `instance`. Returns project uuid, name and description plus the uuid and
name of every environment inside it — the identifiers Coolify requires when
creating a resource. Older Coolify releases do not embed the relation in the list
response; when that happens the hint says so and points at
`get-project-by-uuid` through `execute_read_operation`, because it is a version
fact rather than an error.

---

## Write tools

All three take `instance` as a **required enum with no default** when more than
one connection is configured. The requirement is enforced in the handler as well
as in the schema, so a client that ignores the published schema still cannot get
an unnamed write through.

### `deploy`

| Parameter | Type | Notes |
|---|---|---|
| `uuid` | string ≤512 | One or more UUIDs, comma-separated. Mutually exclusive with `tag`. |
| `tag` | string ≤255 | Deploy every resource carrying this Coolify tag. |
| `force` | boolean | Rebuild without the Docker layer cache. |
| `pull_request_id` | int ≥1 | Deploy a PR preview instead of the production branch. Requires `uuid`. |
| `docker_tag` | string ≤255 | For registry-image applications: the image tag to deploy. |
| `wait` | boolean | Default false. Stay in the call until the deployment reaches a terminal status. |
| `timeout_seconds` | int 30–900 | Default 300. Only used with `wait`. |

Exactly one of `uuid` or `tag` is required. The illegal combinations are rejected
locally — they are structural, not incidental, and a local error saves a round
trip.

With `wait: true` the handler polls to a terminal status (`finished`, `failed`,
`cancelled_by_user`, `skipped`), emits `notifications/progress` **only when the
caller supplied a progress token** (emitting one unasked is a protocol violation),
listens to the cancellation signal, and returns the tail of the build log when
the deployment did not succeed. A silent five-minute call looks like a hang;
this is why progress exists.

`idempotentHint: false` — two calls start two builds, and with `force` they are
two full rebuilds.

> **Honest caveat.** `POST /v1/deploy`'s response body has not been confirmed
> against a live instance. The handler reads the documented
> `{ deployments: [...] }` shape and tolerates the containers Coolify uses
> elsewhere; when it cannot find a `deployment_uuid` it falls back to matching on
> the application's deployment history, which is timestamp-based and therefore
> racy under concurrent deploys.

### `control_resource`

| Parameter | Type | Notes |
|---|---|---|
| `action` | `start` \| `stop` \| `restart` | Required. |
| `resource_type` | enum | Required. |
| `uuid` | string ≤255 | Required. |
| `force` | boolean | Only on `start` of an application. |
| `instant_deploy` | boolean | Only on `start` of an application: skip the deployment queue. |
| `docker_cleanup` | boolean | Only on `stop`: reclaim space from unused images and volumes afterwards. |
| `latest` | boolean | Only on `restart` of a service: pull the latest image tags first. |

A flag passed for a combination that does not accept it is **rejected locally**
rather than ignored, so you learn that the request you made is not the request
that would have run.

#### Why `destructiveHint: false`, and why this is not behind the flag

A reviewer will question this, so the reasoning is here rather than implied.

Stopping production causes downtime, and downtime is not nothing. But
`COOLIFY_ALLOW_DESTRUCTIVE` answers a narrower question: *can this server destroy
something I cannot get back?* A stop destroys no data, removes no configuration,
and is undone by the `start` sitting in the same enum of the same tool. Coolify's
genuinely destructive operations — the DELETEs, and `POST /disable`, which locks
the API token out of its own instance — are what the flag exists for.

Putting stop behind the flag would change what the flag *means*. It would stop
being "can I destroy data" and become "can I do anything useful", because start,
stop, restart and deploy are the whole point of a Coolify MCP server. Users would
then set it as a matter of course during setup, and by the time they reached a
real DELETE the flag would be long since on and would signify nothing. A safety
switch that everyone turns on immediately protects no one — it just adds a step
and teaches people that the warnings are noise.

The mitigations that do apply are the honest ones: `readOnly` connections refuse
this tool outright at the transport, `instance` is required with no default so a
production stop cannot happen through an omitted parameter, and
`destructiveHint: false` is **truthful**, which keeps your host's own confirmation
prompts meaningful for the operations that genuinely are destructive.

### `set_environment_variables`

| Parameter | Type | Notes |
|---|---|---|
| `resource_type` | enum | Required. |
| `uuid` | string ≤255 | Required. |
| `variables` | array, 1–100 | `{key, value, is_preview?, is_build_time?}` |

`key` may not contain whitespace or `=` — both make the variable unusable in the
container the moment it is exported, and Coolify does not reject them for you.
The same key twice in one request is rejected locally, because the outcome would
depend on the order Coolify happens to apply them.

Existing keys are updated in place and keys not listed are left untouched. This
tool **does not delete** — deletion is a destructive operation. For applications
the new values take effect on the next deployment, not immediately.

---

## The catalog tools

Everything in Coolify's published API that does not have a dedicated tool is
reachable through three steps: `search_operations` → `describe_operation` →
`execute_*`.

The catalog is generated at build time from Coolify's OpenAPI spec and compiled
into the package. Current contents:

| | |
|---|---|
| Coolify version | **4.2.0** |
| Spec sha256 | `150e9f3c…` |
| Operations | **189** |
| By class | 74 safe · 86 write · 29 destructive |
| Flagged `costly` | 3 — `POST /servers/{hetzner,digitalocean,vultr}`, which provision billable cloud infrastructure |

Building at release time rather than fetching at runtime is deliberate: a runtime
fetch would mean parsing 795 KB on every stdio spawn, a network dependency for a
tool that has to work on an offline homelab, a spec that may not match the user's
version anyway, and non-determinism in an MIT package — a supply-chain smell.

### `search_operations`

| Parameter | Type | Notes |
|---|---|---|
| `query` | string | Free text against operation id, path and summary. |
| `family` | enum | One of 16 families: `applications`, `databases`, `services`, `servers`, `projects`, `deployments`, `teams`, `security`, `destinations`, `github-apps`, `cloud-tokens`, `hetzner`, `digitalocean`, `vultr`, `tags`, `other`. |
| `method` | enum | `GET`, `POST`, `PATCH`, `PUT`, `DELETE`. |
| `limit` | int 1–100 | Default 20. |

Whole-token matches outrank substring matches, and a small alias map covers the
places where Coolify's vocabulary diverges from the question a person types —
`environment`/`variable`/`var` all reach `envs`, `db` reaches `database`. Without
that, `list-envs-by-application-uuid` is unreachable by search, because nothing in
its id, path or summary contains a word anyone actually types.

**Results are filtered to what this server can actually run.** Operations with no
available door are **omitted**, not labelled. If destructive is off, destructive
operations do not appear at all — otherwise the model finds
`delete-application-by-uuid`, discovers there is no door for it, and stalls, which
is the worst outcome because it looks like a capability the server is hiding.

A zero-result search reports the catalog's provenance rather than apologising:
the single most likely cause of a miss on a self-hosted PaaS is an instance newer
than the catalog we shipped.

### `describe_operation`

Takes `operation_id`. Returns method, path, family, summary, danger class, path
and query parameters, the pruned JSON Schema of the request body, and **which
`execute_*` tool runs it**.

Schemas are returned one operation at a time because they are large enough that
returning them for a page of search results would crowd out everything else.

Ids resolve against the same filtered view `search_operations` uses:
`describe_operation` must not reveal what `search_operations` hides, or the
catalog stops being a truthful map of what this server can do.

### `execute_read_operation` / `execute_write_operation` / `execute_destructive_operation`

| Parameter | read | write | destructive |
|---|:--:|:--:|:--:|
| `instance` | optional, may default | required | required |
| `operation_id` | ● | ● | ● |
| `path_params` | ● | ● | ● |
| `query` | ● | ● | ● |
| `body` | — | ● | — |
| `fields` | ● | — | — |
| `reveal` | ● | ● | — |

`fields` is a dot-path allowlist applied to every row of an array response —
`["uuid", "name", "settings.is_static"]`. It exists because Coolify list
endpoints are unpaginated and return complete records: a bare list of
applications can be megabytes. A field absent upstream stays absent rather than
being emitted as `null`, because `"field": null` asserts that the value *is* null,
which is a different and wrong claim.

#### Why three doors and not one

Anthropic's tool-design review criteria state it plainly: a single tool that
accepts both GET and POST/PUT/PATCH/DELETE is rejected, and documenting safe
versus unsafe inside one description does not satisfy the rule. A `method`
parameter satisfies it even less — it makes the danger class an argument the
model chooses. So the danger class picks the tool, and each tool carries
annotations that are true of *everything* it can run.

#### Body validation is deliberately permissive

`body` is `z.record(z.unknown()).optional()`. Path parameters **are** validated
strictly — they come from the URL template, so the catalog cannot be wrong about
them the way it can be wrong about a body schema — and query parameter *names* are
checked against the catalog, but nothing about the body is.

This inverts the usual "tight schemas prevent bad calls" advice, and the
justification is that tight schemas are worth it only when the schema source is
trustworthy. Coolify's OpenAPI document is generated from PHP attributes and is
known wrong in places
([upstream #7702](https://github.com/coollabsio/coolify/issues/7702)). A generic
executor that hard-validated against it would reject **valid** calls with no way
for the model to override — a hard failure manufactured entirely by our own
scaffolding, on an endpoint we never hand-verified.

Coolify's own validator is the authority instead. Its 422 body arrives as
`{"message":…,"errors":{"field":["…"]}}` and is passed through **verbatim**, which
turns a rejected call into a one-turn self-correction. The promoted, hand-verified
tools are where tight schemas belong; this is not that path.

---

## The destructive gate

Three layers, one flag.

| Layer | Where | What it does |
|---|---|---|
| **1. Registration** | `src/tools/register.ts` | With the flag off, `execute_destructive_operation` **is not registered** — absent from `tools/list` entirely. |
| **2. Dispatch** | `src/tools/generic.ts` | Every `execute_*` handler re-checks that the operation's danger class and HTTP method match the door it arrived through. |
| **3. Transport** | `src/http/client.ts` | Before the socket opens: destructive + `!allowDestructive` is refused, and so is any non-GET on a `readOnly` connection. |

**The gate is enforced at one throat, not at each tool boundary.** Promoted tools,
generic tools and every tool written after this file all go through the same HTTP
client. There is no way around it.

Layer 2 looks redundant — the tool boundary already says which class it serves —
but the classification is **generated** from an upstream OpenAPI spec. A
regeneration against a new Coolify release can misfile a DELETE into the write
bucket, and the tool boundary would then be enforcing nothing. A security property
that holds only because a code generator got it right is not a security property.

Layer 3 computes its own verdict independently and takes whichever is stricter, so
a classifier returning `safe` for a DELETE cannot unlock anything. It also carries
a small hand-maintained override list — `POST /disable` and `POST /mcp/disable` —
matched on operation id **and** on method+path. Neither is a DELETE, so a "block
the DELETEs" rule misses both, and both switch the API off, which locks the token
out of its own instance irreversibly from the token's point of view.

### Why registration-time gating rather than list-and-refuse

1. **Every tool schema is tokens spent on every turn**, whether or not the tool is
   ever called. A tool that structurally always refuses is pure waste of the
   budget this whole design exists to conserve.
2. **There is no recovery path the model can take.** Enabling the capability means
   a human sets an environment variable and restarts the server — an action the
   model cannot perform and cannot retry into. A listed tool that always refuses
   invites a call → refusal → rephrase → call loop against a wall no rephrasing
   moves.
3. **With it unregistered, no tool in the list carries `destructiveHint: true`.**
   The host's permission model and the server's actual capability then agree
   exactly, so a host that auto-approves non-destructive tools is auto-approving
   something genuinely non-destructive.

The one thing this throws away — that the capability exists and how to turn it on
— is recovered in a single sentence of `instructions`, added exactly when it is
useful and suppressed under read-only, where it would be false.

---

## Response shaping

Every tool returns the same envelope:

```json
{
  "instance": "prod",
  "data": [ … ],
  "meta": {
    "count": 20,
    "total": 137,
    "next_cursor": "eyJvZmZzZXQiOjIwLCJx…",
    "truncated": 0,
    "truncation": null,
    "hint": "Rows 1-20 of 137. …",
    "errors": []
  }
}
```

`instance` appears only when more than one connection is configured. `errors[]`
appears only on a fan-out with partial failures.

**Budget: 130,000 bytes**, under the ~150k character ceiling of claude.ai and
Claude Desktop with room for the envelope and multi-byte characters. In practice
Claude Code's ~25k token ceiling binds first.

Four mechanisms, in order of how much work they do:

1. **Projection — 95% of it.** Every list tool declares an **allowlist**, not a
   denylist: a denylist starts leaking every column a future Coolify release adds,
   regressing the budget on someone else's schedule. Each allowlist lives in its
   own tool's module rather than a shared barrel, because a projection only stays
   correct if it moves when its tool moves.
2. **Our own pagination.** Fetch-all → filter → sort → slice, in-process.
   `next_cursor` is an opaque base64 `{offset, queryHash}`; the hash is of the
   filters the cursor was produced under, so replaying it against a different
   query is refused rather than silently walking a different result set. **See the
   limitations note in the [README](../README.md#limitations): this is offset
   pagination over a re-fetched list and is not stable under concurrent
   mutations.**
3. **Byte-budgeted logs.** Request `lines` → strip ANSI escapes → trim from the
   **front** (the failure is at the end), with an `[… N earlier lines dropped …]`
   note.
4. **Graduated narrowing.** Over budget: prune columns in each tool's declared
   `prunable` order → drop rows → truncate a single oversized field in place. Every
   step sets `meta.truncation` to `field_prune`, `row_limit` or `field_value`, so
   truncation is never silent.

## Instructions

The `instructions` string the server sends in `initialize` is assembled from the
**registered set** — the same `selectTools` gate `registerTools` runs — never
re-derived from the flags. A sentence naming a tool that was not registered sends
the model looking for a door that does not exist.

Two rules hold for every sentence: it states a **fact** about this server's
configuration or capability surface, and it never tells the model how to behave.
`instructions` is a description channel, not a prompt.
