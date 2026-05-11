% randn() / rng() — Marsaglia polar method with spare cache,
% matching numbl's `boxMullerRandom`.

rng(0);
disp(randn());            % scalar N(0, 1)
disp(randn());            % uses cached spare from first call

rng(0);
a = randn(3);             % 3x3
disp(a);

rng(123);
b = randn(2, 4);
disp(b);
