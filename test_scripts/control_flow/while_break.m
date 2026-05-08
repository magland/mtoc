k = 0;
s = 0;
while true
  k = k + 1;
  if k > 100
    break;
  end
  if k > 5
    continue;
  end
  s = s + k;
end
disp(s);
disp(k);
