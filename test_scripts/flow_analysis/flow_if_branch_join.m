% Each branch assigns x with a different sign. After the if, x's
% inferred sign should be the join across all branches (positive joined
% with negative ⇒ nonzero), and only operations that work for `nonzero`
% should be accepted.
n = 7;
if n > 0
  x = 1;
elseif n == 0
  x = 0;
else
  x = -1;
end
% Show that x flowed through correctly — disp accepts any scalar.
disp(x);

% A separate variable that's only assigned in one branch — falls through
% to the predeclared 0 on the other branches. Should join to a nonneg.
flag = 0;
if n > 5
  flag = 1;
end
disp(flag);
disp(sqrt(flag));   % only valid because flag is nonneg-typed (0 or 1)
