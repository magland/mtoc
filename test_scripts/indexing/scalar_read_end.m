v = [10, 20, 30, 40];
disp(v(end));
disp(v(end - 1));
disp(v(end - 3));
% `end` in arithmetic
n = v(end) - v(1);
disp(n);
% end in a for bound (just `end` keyword usage check)
total = 0;
for k = 1:length(v)
  total = total + v(k);
end
disp(total);
