f = get_doubler();
disp(f(7));
disp(f(2.5));

g = get_squarer();
disp(g(5));

function h = get_doubler()
  h = @double_it;
end

function h = get_squarer()
  h = @(x) x * x;
end

function y = double_it(x)
  y = x + x;
end
