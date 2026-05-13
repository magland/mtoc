% Homogeneous cell of doubles, with variable-index access.
c = {10, 20, 30, 40};
total = 0;
for i = 1:4
  total = total + c{i};
end
disp(total);
