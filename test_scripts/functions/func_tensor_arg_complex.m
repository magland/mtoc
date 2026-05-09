function s = sum_squares(v)
  w = v .* v;
  s = sum(w);
end

x = [1+1i, 2+2i, 3-1i];
disp(sum_squares(x));
