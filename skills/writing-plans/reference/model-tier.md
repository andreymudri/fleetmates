# Writing plans: declaring a model tier

A task may declare the model tier it should run at:

    **Model:** cheap

Valid values are `cheap`, `mid`, and `capable`. Omit the line and `init-run` infers a tier
from the task's shape — how many other tasks depend on it, how many files it declares, and
whether its brief already contains the code to write. Declare one only when you know the
inference would be wrong; an unrecognised value fails `init-run` with the offending task id.
