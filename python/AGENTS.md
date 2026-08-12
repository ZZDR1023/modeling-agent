# Python Experiment Rules

- Python is an execution plane, not the source of run state.
- Read only the mounted input and request; write only to `/workspace/output`.
- Emit one Schema-valid result manifest even when the experiment fails.
- Never silently sample, truncate, impute, aggregate, or discard data.
- Fit preprocessing only on training data where evaluation splitting applies.
- Use mature numerical libraries for algorithms; own validation, baselines, and evidence generation.
- Network, subprocess spawning, dynamic package installation, unsafe deserialization, and host path access are forbidden in the initial profile.
