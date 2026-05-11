% A 1×1 tensor literal `[x]` is statically scalar and folds to its
% single element at lowering. Regression: before the fold, ANF was
% hoisting it as an owned producer while predeclaring the consumer as
% a scalar, producing a `mtoc_tensor_assign(&scalar_double, ...)`
% type mismatch.

y = [42];
disp(y);

n = [-3.5];
disp(n);

% Expression cell — fold preserves the inner IR.
a = 10;
b = 5;
w = [a + b];
disp(w);

% Used in arithmetic (no temp needed).
disp([7] + [3]);

% Used as a cell inside a larger tensor literal — the outer literal's
% per-cell scalar requirement is met by the folded inner.
M = [1, 2; 3, [4]];
disp(M);

% Non-conjugate transpose of a 1×1 literal is identity.
disp([99].');
