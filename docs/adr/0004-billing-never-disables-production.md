# Billing enforcement never disables production traffic

Billing state may warn, apply a grace period, pause new billable work, or place a workspace into a recovery-only mode. It must not deactivate runtime capacity, delete releases, or move production aliases away from a healthy release. This preserves customer traffic while payment and reconciliation issues are resolved.
