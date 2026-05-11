% Empty ranges (start > end with positive step, or start < end with
% negative step) should iterate zero times. Exercises the loop-count
% helper's "n <= 0 → return 0" arm.
n = 0;
for i = 5:3
    n = n + 1;
end
disp(n);

m = 0;
for i = 1:-1:5
    m = m + 1;
end
disp(m);

% Non-empty downward range still iterates correctly.
k = 0;
for i = 5:-1:1
    k = k + 1;
end
disp(k);
