function s = energy(v)
  w = v .* v;
  s = sum(w);
end

x = [1 2 3 4];
disp(energy(x));
