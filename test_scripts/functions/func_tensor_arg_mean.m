function s = avg(v)
  s = sum(v) / length(v);
end

x = [1.0 2.0 3.0 4.0 5.0];
m = avg(x);
disp(m);
