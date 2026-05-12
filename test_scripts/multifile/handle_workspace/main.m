f = @helper;
disp(f(5));
disp(apply(@helper, 7));

function r = apply(h, x)
  r = h(x);
end
