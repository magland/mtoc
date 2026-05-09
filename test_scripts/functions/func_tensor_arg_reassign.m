function r = scale(v, k)
  v = v .* k;
  r = sum(v);
end

x = [1 2 3 4];
disp(scale(x, 2));
disp(scale(x, 10));
disp(sum(x));
