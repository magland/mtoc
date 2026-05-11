% Cross-runner coverage for `fprintf` with vector / matrix args.
% numbl's `sprintfFormat` flattens tensors column-major and cycles the
% format string through the flattened element stream.
v = [1 2 3];
fprintf('%d\n', v);

% Two specs per pass, four elements → "1 2\n3 4\n".
fprintf('%d %d\n', [1 2 3 4]);

% Column-major flatten of a matrix: [1 2; 3 4] reads 1, 3, 2, 4.
M = [1 2; 3 4];
fprintf('%d ', M);
fprintf('\n');

% Format cycling over a longer vector with a non-trivial spec.
x = [1 2 3 4 5];
fprintf('%g\n', x);

% Tensor that's the result of arithmetic — assigned to a name first
% (same rule as `disp` for non-owned-producer multi-element exprs).
a = [1 2 3];
b = [10 20 30];
ab = a + b;
fprintf('%d ', ab);
fprintf('\n');
