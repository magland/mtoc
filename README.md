# mtoc

Static MATLAB-to-C translator. Operates on a strict subset of MATLAB-style code: parses, infers types, generates a self-contained C source file.

## Usage

```bash
npx tsx src/cli.ts translate input.m output.c
npx tsx src/cli.ts run input.m
```

`run` translates to a temporary directory, compiles with `cc` (override via the `CC` env var), and runs the resulting binary.

## Status

Early scaffold. Today only a tiny scalar subset works:

```matlab
% examples/example1.m
x = 3;
y = 4.5;
z = x + y * 2;
disp(z);
```

emits

```c
#include <stdio.h>
int main(void) {
  double x = 3.0;
  double y = 4.5;
  double z = x + y * 2.0;
  printf("%g\n", z);
  return 0;
}
```

Anything outside this subset (tensors, control flow, user-defined functions, complex numbers, strings, classes, …) currently raises an `UnsupportedConstruct` error. Each addition is a separate iteration.
