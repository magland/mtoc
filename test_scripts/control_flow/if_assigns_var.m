% A variable first assigned inside one branch should still be readable
% after the if (predeclaration ensures this is well-defined in C).
n = 7;
if n > 0
  sign = 1;
elseif n == 0
  sign = 0;
else
  sign = -1;
end
disp(sign);
