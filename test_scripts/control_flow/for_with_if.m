% Sum the triangle numbers k*(k+1)/2 that are below 50.
s = 0;
for k = 1:20
  t = k * (k + 1) / 2;
  if t < 50
    s = s + t;
  end
end
disp(s);
