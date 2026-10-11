export class DesktopCredentialStoreError extends Error {
  constructor() { super("desktop_credential_store_unavailable"); this.name = "DesktopCredentialStoreError"; }
}

export class DesktopSessionChangedError extends Error {
  constructor() { super("desktop_session_changed"); this.name = "DesktopSessionChangedError"; }
}

// An unexpected account response must never replace the saved credentials.
export class DesktopAccountMismatchError extends Error {
  constructor() { super("desktop_token_account_mismatch"); this.name = "DesktopAccountMismatchError"; }
}
