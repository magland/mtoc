% fprintf inside a for loop with a format-string variable (not a
% literal) — exercises the Var path through the format-arg
% validator and codegen. Also covers the dead-after-free liveness
% for any tensor args consumed at each iteration.

fmt = '%d squared is %d\n';
for i = 1:5
  fprintf(fmt, i, i * i);
end

% fprintf in an if branch — separate freed-set accounting.
x = 7;
if x > 0
  fprintf('positive: %d\n', x);
else
  fprintf('non-positive: %d\n', x);
end

% sprintf result accumulated across iterations into a string variable.
acc = "";
for i = 1:3
  acc = acc + sprintf("[%d]", i);
end
disp(acc);
