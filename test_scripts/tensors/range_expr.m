% Bare range expressions `a:b` and `a:s:b` materialize a 1xn row vector.
% Cross-runs against numbl's `runtimeRange` byte-for-byte.

v = 1:5;
disp(v);
disp(numel(v));
disp(size(v));

% Explicit step
w = 0:0.25:1;
disp(w);

% Descending
d = 5:-1:1;
disp(d);

% Float endpoints
f = -1:0.5:1;
disp(f);

% Empty range (start > end with positive step) -> 1x0
e = 5:1;
disp(numel(e));
disp(size(e));

% Range fed through downstream ops
v2 = (1:5) + 1;
disp(v2);
disp(sum(1:10));
disp(numel(1:5));

% Range value reused
r = 1:10;
disp(r(3));
disp(r(2:4));

% Runtime-shaped (n is a variable)
n = 4;
disp(1:n);

% In a for-body — range as a value, not as iterable
for k = 1:3
    x = 1:k;
    disp(numel(x));
end
