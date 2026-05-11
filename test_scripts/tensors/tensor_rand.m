% rand() / rng() — seeded for cross-runner reproducibility.
% Both runtimes use xoshiro128** + splitmix32 with the same
% bit-level operations, so post-rng output is byte-identical.

rng(42);
disp(rand());             % scalar U(0, 1)
disp(rand());             % another scalar draw

rng(42);
a = rand(3);              % 3x3 — same state as if we'd drawn 9 scalars
disp(a);

rng(7);
b = rand(2, 3);
disp(b);
disp(size(b));            % [2 3]

% N-D rand.
rng(1);
c = rand(2, 2, 2);
disp(size(c));            % [2 2 2]
disp(numel(c));           % 8
