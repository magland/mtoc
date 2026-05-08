% sqrt(k) inside `for k = 1:n` should typecheck without `abs`,
% because the loop-variable sign is refined to positive.
n = 9;
s = 0;
for k = 1:n
  s = s + sqrt(k);
end
disp(round(s * 10000));

% With start=0 the variable is only nonneg, but sqrt still accepts.
t = 0;
for k = 0:5
  t = t + sqrt(k);
end
disp(round(t * 10000));

% x*x is detected as nonneg even when x is unknown.
function y = norm2(a, b)
  y = sqrt(a*a + b*b);
end

disp(norm2(3, 4));
disp(norm2(-5, 12));
