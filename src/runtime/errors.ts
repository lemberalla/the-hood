export class TheHoodError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly exitCode = 1
  ) {
    super(message);
    this.name = "TheHoodError";
  }
}

export class InputError extends TheHoodError {
  constructor(message: string) {
    super(message, "invalid_input", 2);
    this.name = "InputError";
  }
}

export class ApprovalRequiredError extends TheHoodError {
  constructor(message: string) {
    super(message, "approval_required", 3);
    this.name = "ApprovalRequiredError";
  }
}

export class ProviderUnavailableError extends TheHoodError {
  constructor(message: string) {
    super(message, "provider_unavailable", 4);
    this.name = "ProviderUnavailableError";
  }
}

export class PermissionDeniedError extends TheHoodError {
  constructor(message: string) {
    super(message, "permission_denied", 6);
    this.name = "PermissionDeniedError";
  }
}

