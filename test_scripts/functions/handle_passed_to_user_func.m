disp(apply(@sq, 5));
disp(apply(@cube, 3));

function r = apply(h, x)
  r = h(x);
end

function y = sq(x)
  y = x * x;
end

function y = cube(x)
  y = x * x * x;
end
