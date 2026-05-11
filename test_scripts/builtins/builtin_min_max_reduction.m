% 1-arg min(t) / max(t) over a tensor — numbl's "reduce along the
% first non-singleton dim" rule. Vectors / vector-likes collapse to a
% scalar; matrices collapse to a row vector.

% Row vector → scalar.
v = [3 1 4 1 5 9 2 6 5 3 5];
disp(min(v));
disp(max(v));

% Column vector → scalar.
c = [10; -3; 7; -8; 2];
disp(min(c));
disp(max(c));

% Built-from-arithmetic vector — exercises the owned-producer arg path.
a = [1 -2 3 -4];
b = [10 20 -30 40];
ab = a + b;
disp(min(ab));
disp(max(ab));

% Single-element vector — degenerate but legal.
disp(min([42]));
disp(max([42]));

% NaN skipping: numbl skips NaNs and returns the smallest / largest
% non-NaN element. If every element is NaN, the result is NaN.
nv = [NaN, 1.0, NaN, -2.0, 3.0];
disp(min(nv));
disp(max(nv));
allnan = [NaN, NaN];
disp(min(allnan));
disp(max(allnan));

% Negative numbers — min/max with mixed signs.
mix = [-5 -1 -10 -3];
disp(min(mix));
disp(max(mix));

% Matrix → row vector of per-column min/max (default-dim reduction
% along dim 1, the first non-singleton axis).
M = [3 1 4; 1 5 9; 2 6 5];
disp(min(M));
disp(max(M));

% Wide matrix.
W = [10 -20 30 -40; -5 6 -7 8];
disp(min(W));
disp(max(W));

% Complex vector → complex scalar. Magnitude orders; ties broken by
% angle. Element with smallest |z| picked for min, largest for max.
z = [3+4i, 1+0i, 0+5i, 2-2i];
disp(min(z));
disp(max(z));

% Complex matrix → complex row vector.
Z = [1+0i, 2+2i; 3-3i, 4+0i];
disp(min(Z));
disp(max(Z));

% 2-arg min/max still elementwise (regression check). One scalar, one
% tensor; one tensor, one tensor. (Elementwise results aren't owned
% producers, so we assign to a name before disp.)
mv1 = min(2, v);
mv2 = max(v, 5);
mv3 = min(a, b);
disp(mv1);
disp(mv2);
disp(mv3);
