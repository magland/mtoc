disp(sum_apply(@sq, [1 2 3 4]));
disp(sum_apply(@cube, [1 2 3]));
disp(sum_apply(@(x) x + 1, [10 20 30]));

function s = sum_apply(h, v)
  s = 0;
  for k = 1:numel(v)
    s = s + h(v(k));
  end
end

function y = sq(x)
  y = x * x;
end

function y = cube(x)
  y = x * x * x;
end
