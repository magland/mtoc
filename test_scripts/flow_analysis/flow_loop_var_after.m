% After a for loop, the loop variable's sign should be widened to
% include the "loop never ran" case (which leaves k at its predeclared
% 0). A `1:n` loop ⇒ inside-body k is positive, after-body k is nonneg.
n = 5;
for k = 1:n
  x = k;   % inside the body, k is positive
end
disp(k);
disp(sqrt(k));  % k is nonneg (positive joined with the implicit 0)

% A loop that may not run at all leaves accumulators at their initial
% values; the merge should reflect that.
total = 0;
for j = 1:n
  total = total + j;
end
disp(total);
