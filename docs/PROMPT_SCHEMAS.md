# Prompt Schemas

TheHood prompts should be schema-bound. The goal is to make model outputs actionable and auditable rather than conversational.

This document defines the first prompt variables and output contracts. Implementation should turn these into typed schemas.

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
  role: planner | researcher | implementer | verifier | critic
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

## Orchestrator Output

```yaml
decision:
  action: delegate | verify | critique | request_approval | revise_plan | complete | abort
  reason: string
  confidence: low | medium | high
  next_role: planner | researcher | implementer | verifier | critic | integrator | null
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

## Verifier Output

```yaml
verification_result:
  verdict: approve | revise | abort | ask_user
  summary: string
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
  blocking_concerns:
    - string
  non_blocking_concerns:
    - string
  alternative_paths:
    - string
  recommended_next_action: string
```

