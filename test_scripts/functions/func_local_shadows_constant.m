% A user function `pi()` would shadow the constant. We don't allow zero-arg
% local functions yet, so just confirm that local-function names take
% precedence over builtins of the same name.
disp(abs2(-3));
disp(abs2(2));

function y = abs2(x)
  y = x * x;
end
