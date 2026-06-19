# Prompt Schemas

TheHood prompts should be schema-bound. The goal is to make model outputs actionable and auditable rather than conversational.

This document defines the first prompt variables and output contracts. The current implementation builds executable directives in `src/runtime/directives.ts` and validates normalized provider responses in `src/runtime/responseContracts.ts`.

## AgentResponse Envelope

Provider responses use JSON for the mechanical runtime contract, not for every human-facing detail.

Every provider returns:

```yaml
agent_response:
  status: ok | blocked | failed
  summary: string
  data:
    <required_data_key>:
      <required control fields>: string | number | boolean | object
      markdown: string
      thehoodDirectiveAck:
        runId: string
        nonce: string
        responseField: thehoodDirectiveAck
```

The runtime validates `status`, `summary`, the required role payload key, role control fields such as `action`, `status`, or `verdict`, and the current directive acknowledgement. Long plans, reports, reviews, critique, rationale, acceptance criteria, and next-step writeups should go in the optional `markdown` string inside the role payload.

Do not encode a long plan or report as deep nested JSON. Use GitHub-flavored Markdown lists, sections, and tables inside `markdown`, while keeping small runtime control fields outside that string.

## Run Variables

```yaml
run:
  run_id: string
  user_goal: string
  mode: plan | implement | review | research
  repo_path: string
  current_state_summary: string
  constraints:
    - string
  approval_policy:
    edit_requires_approval: boolean
    dependency_install_requires_approval: boolean
    network_requires_approval: boolean
    protected_test_paths:
      - string
  max_iterations: number
  token_budget: number | null
  time_budget_seconds: number | null
  stop_conditions:
    - string
  success_criteria:
    - string
  output_contract: string
```

## Orchestrator Variables

```yaml
orchestrator:
  role: orchestrator
  provider: string
  model: string
  available_worker_types:
    - planner
    - researcher
    - implementer
    - qa
    - verifier
    - critic
  available_tools:
    - read_state
    - delegate
    - request_approval
    - request_verification
    - request_critique
  allowed_paths:
    - string
  disallowed_paths:
    - string
  risk_level: low | medium | high
  delegation_rules:
    - string
  effort_scaling_rules:
    - string
  prior_findings:
    - string
  verifier_results:
    - verdict: approve | revise | abort | ask_user
      summary: string
  open_questions:
    - string
```

## Worker Variables

```yaml
worker:
  role: planner | researcher | implementer | qa | verifier | critic
  objective: string
  scope:
    allowed_paths:
      - string
    disallowed_paths:
      - string
    protected_paths:
      - string
  relevant_files:
    - path: string
      reason: string
  allowed_tools:
    - string
  disallowed_tools:
    - string
  expected_output_format: string
  evidence_required:
    - string
  max_tool_calls: number
  max_turns: number
  done_definition:
    - string
```

## Verifier Variables

```yaml
verifier:
  role: verifier
  claimed_changes:
    - string
  acceptance_criteria:
    - string
  changed_files:
    - string
  diff_summary: string
  raw_diff_ref: string
  test_commands:
    - command: string
      cwd: string
  expected_tool_trajectory:
    - string
  actual_logs:
    - command: string
      exit_code: number
      stdout_ref: string
      stderr_ref: string
  failure_classification:
    - test_failure
    - lint_failure
    - typecheck_failure
    - build_failure
    - schema_failure
    - permission_denied
    - provider_error
    - unknown_failure
  recommendation: approve | revise | abort | ask_user
```

## Memory Variables

```yaml
memory:
  canonical_refs:
    - kind: run | plan | directive | response | diff | log | validation | verifier_verdict | final_report | reconciliation
      ref: string
      summary: string
  repo_state:
    git_head: string | null
    dirty: boolean
    changed_files:
      - string
  plan_state:
    plan_ref: string | null
    completed_items:
      - string
    open_items:
      - string
    superseded_by: string | null
  retrieval_policy:
    source_artifacts_are_authoritative: true
    summaries_are_non_authoritative: true
    ignore_provider_session_memory: true
```

## Reconciliation Variables

```yaml
reconciliation:
  role: orchestrator | planner
  original_plan_ref: string
  latest_plan_state_ref: string | null
  progress_packet_ref: string
  implementation_refs:
    - string
  validation_refs:
    - string
  verifier_refs:
    - string
  acceptance_criteria:
    - string
  open_questions:
    - string
```

## Orchestrator Output

```yaml
decision:
  action: delegate | verify | critique | request_approval | revise_plan | complete | abort
  reason: string
  markdown: string | null
  confidence: low | medium | high
  next_role: planner | researcher | implementer | qa | verifier | critic | integrator | null
  task:
    objective: string
    allowed_paths:
      - string
    disallowed_paths:
      - string
    acceptance_criteria:
      - string
    tool_permissions:
      read: boolean
      edit: boolean
      shell: boolean
      network: boolean
  approval_request:
    required: boolean
    reason: string | null
    options:
      - approve
      - reject
      - revise
  stop:
    should_stop: boolean
    reason: string | null
```

## Implementer Output

```yaml
implementation_result:
  status: changed | no_change | blocked | failed
  markdown: string | null
  changed_files:
    - path: string
      change_type: added | modified | deleted | renamed
      summary: string
  protected_file_changes:
    - path: string
      reason: string
  commands_run:
    - command: string
      exit_code: number
      summary: string
  notes:
    - string
  unresolved_risks:
    - string
```

## QA Tester Output

```yaml
qa_result:
  verdict: pass | needs_revision | needs_more_evidence | blocked
  summary: string
  markdown: string | null
  suggested_commands:
    - string
  risks:
    - string
  thehoodDirectiveAck:
    runId: string
    nonce: string
    responseField: thehoodDirectiveAck
```

The QA tester output is advisory. It can recommend deterministic validation and identify missed cases, but it cannot satisfy the runtime QA/validation lane.

## Verifier Output

```yaml
verification_result:
  verdict: approve | revise | abort | ask_user
  summary: string
  markdown: string | null
  evidence:
    - kind: diff | test_log | lint_log | typecheck_log | file_read | runtime_metadata
      ref: string
      finding: string
  failed_criteria:
    - string
  risks:
    - severity: low | medium | high
      description: string
  next_action:
    role: orchestrator | implementer | user | none
    instruction: string
```

## Critic Output

```yaml
critique_result:
  verdict: acceptable | needs_revision | unsafe | unclear
  markdown: string | null
  blocking_concerns:
    - string
  non_blocking_concerns:
    - string
  alternative_paths:
    - string
  recommended_next_action: string
```

## Critic Trigger Artifact

```yaml
critic_trigger:
  schemaVersion: 1
  kind: critic_trigger
  runId: string
  called: true
  reasonCode: qa_failed | qa_inconclusive | verifier_failed | verifier_inconclusive | validation_mismatch
  reason: string
  sourceRoles:
    - qa | verifier
  evidenceRefs:
    - string
  criticResponseRef: string
```

This artifact is written by the runtime. Providers may inspect it as context, but they do not decide whether it exists.

## Reconciliation Output

```yaml
reconciliation_result:
  status: complete | partial | off_plan | blocked
  markdown: string | null
  completed_plan_items:
    - string
  satisfied_criteria:
    - string
  missing_plan_items:
    - string
  deviations:
    - string
  next_recommended_slice:
    objective: string
    rationale: string
    acceptance_criteria:
      - string
  needs_user_decision: boolean
  user_decision_reason: string | null
```
