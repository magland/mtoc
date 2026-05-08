disp(fact(0));
disp(fact(1));
disp(fact(5));
disp(fact(10));
disp(triangular(100));

function r = fact(n)
  r = 1;
  for k = 1:n
    r = r * k;
  end
end

function s = triangular(n)
  s = 0;
  for k = 1:n
    s = s + k;
  end
end
