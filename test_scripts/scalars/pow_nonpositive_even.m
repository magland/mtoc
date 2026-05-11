% Regression: nonpositive base raised to a positive even integer exponent
% must produce a nonnegative result so sqrt() accepts it without error.
% x is coarsened to sign=nonpositive by the if-false branch join with zero.
x = -3;
if false
  x = 0;
end
y = x ^ 2;
disp(sqrt(y));
