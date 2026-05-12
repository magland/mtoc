f = @sqrt;
disp(f(9));
disp(f(2));
g = @sin;
disp(g(0));

function r = apply(h, x)
  r = h(x);
end

disp(apply(@cos, 0));
disp(apply(@abs, -3));
