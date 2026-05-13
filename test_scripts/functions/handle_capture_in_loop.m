total = 0;
for i = 1:5
  f = @(x) x + i;
  total = total + f(10);
end
disp(total);

% Each iteration creates a fresh handle with a fresh snapshot of i.
% Total = (10+1) + (10+2) + (10+3) + (10+4) + (10+5) = 65
